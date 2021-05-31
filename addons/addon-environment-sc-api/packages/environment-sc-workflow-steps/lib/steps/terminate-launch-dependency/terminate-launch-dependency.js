/*
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License").
 *  You may not use this file except in compliance with the License.
 *  A copy of the License is located at
 *
 *  http://aws.amazon.com/apache2.0
 *
 *  or in the "license" file accompanying this file. This file is distributed
 *  on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
 *  express or implied. See the License for the specific language governing
 *  permissions and limitations under the License.
 */

const _ = require('lodash');
const url = require('url');
const yaml = require('js-yaml');

const StepBase = require('@aws-ee/base-workflow-core/lib/workflow/helpers/step-base');
const {
    getServiceCatalogClient,
} = require('@aws-ee/environment-type-mgmt-services/lib/environment-type/helpers/env-type-service-catalog-helper');
const environmentStatusEnum = require('../../helpers/environment-status-enum');
const jsYamlCustomSchema = require('../../helpers/js-yaml-custom-schema');

const inPayloadKeys = {
    requestContext: 'requestContext',
    envId: 'envId',
    envName: 'envName',
    xAccEnvMgmtRoleArn: 'xAccEnvMgmtRoleArn',
    externalId: 'externalId',
    provisionedProductId: 'provisionedProductId',
    existingEnvironmentStatus: 'existingEnvironmentStatus',
};

const settingKeys = {
    envMgmtRoleArn: 'envMgmtRoleArn',
};

const pluginConstants = {
    extensionPoint: 'env-provisioning',
};


const failureStatuses = [
    'CREATE_FAILED',
    'ROLLBACK_FAILED',
    'DELETE_FAILED',
    'UPDATE_ROLLBACK_FAILED',
    'ROLLBACK_COMPLETE',
    'UPDATE_ROLLBACK_COMPLETE',
];
const successStatuses = ['CREATE_COMPLETE', 'DELETE_COMPLETE', 'UPDATE_COMPLETE'];

/**
 * Workflow step that terminates the launch dependencies of a product created while lauching the product
 * Dependency check is performed based on the output of the product CFT
 */
class TerminateLaunchDependency extends StepBase {
    inputKeys() {
        return {
            [inPayloadKeys.requestContext]: 'object',
            [inPayloadKeys.envId]: 'string',
            [inPayloadKeys.externalId]: 'string',
            [inPayloadKeys.provisionedProductId]: 'string',
            [inPayloadKeys.existingEnvironmentStatus]: 'string',
        };
    }

    async start() {
        const [requestContext, envId, externalId, existingEnvironmentStatus] = await Promise.all([
            this.payloadOrConfig.object(inPayloadKeys.requestContext),
            this.payloadOrConfig.string(inPayloadKeys.envId),
            this.payloadOrConfig.string(inPayloadKeys.externalId),
            this.payloadOrConfig.string(inPayloadKeys.existingEnvironmentStatus),
        ]);
        const [albService, environmentScService] = await this.mustFindServices(['albService', 'environmentScService']);
        const environment = await environmentScService.mustFind(requestContext, { id: envId });
        const projectId = environment.projectId;
        const awsAccountId = await albService.findAwsAccountId(requestContext, projectId);
        //Locking the ALB termination to avoid race condiitons on parallel provisioning.
        //expiresIn is set to 10 minutes. attemptsCount is set to 600 to retry after 1 seconds for 10 minutes
        await lockService.tryWriteLockAndRun({ id: `alb-update-${awsAccountId}`, expiresIn: 600 }, async () => {
            // Setting project id to use while polling for status
            this.state.setKey('PROJECT_ID', projectId);
            // convert output array to object. Return {} if no outputs found
            const environmentOutputs = await this.cfnOutputsArrayToObject(_.get(environment, 'outputs', []));
            const connectionType = _.get(environmentOutputs, 'MetaConnection1Type', '');
            // Clean up listener rule and Route53 record before deleting ALB and Workspace
            if (connectionType.toLowerCase() === 'rstudiov2') {
                const [albService, environmentDnsService] = await this.mustFindServices(['albService', 'environmentDnsService']);
                const albExists = await albService.checkAlbExists(requestContext, projectId);
                if (albExists) {
                    try {
                        const deploymentItem = await albService.getAlbDetails(requestContext, projectId);
                        const dnsName = JSON.parse(deploymentItem.value).albDnsName;
                        await environmentDnsService.deleteRecord('rstudio', envId, dnsName);
                    } catch (error) {
                        // Don't fail the termination if record deletion failed
                        this.print({
                            msg: `Record deletion failed with error - ${error.message}`,
                        });
                    }
                }
                const ruleArn = _.get(environmentOutputs, 'ListenerRuleARN', null);
                //Skipping rule deletion for the cases where the product provisioing failed before creating rule
                //Termination should not be affected in such scenarios
                if (ruleArn) {
                    try {
                        //creating resolvedvars object with the necessary Metadata
                        const resolvedVars = {
                            projectId: projectId,
                            externalId: externalId
                        };
                        await albService.deleteListenerRule(requestContext, resolvedVars, ruleArn);
                    } catch (error) {
                        // Don't fail the termination if rule deletion failed
                        this.print({
                            msg: `Rule deletion failed with error - ${error.message}`,
                        });
                    }
                }
            }
            // Get Template outputs to check NeedsALB flag. Not reading template outputs from DB
            // Because failed products will not have outputs stored
            const templateOutputs = await this.getTemplateOutputs(requestContext, environment.envTypeId);
            const needsAlb = _.get(templateOutputs.NeedsALB, 'Value', false);
            if (needsAlb) {
                //Dont decrease count for failed products
                if (!_.includes(['FAILED', 'TERMINATING_FAILED'], existingEnvironmentStatus)) {
                    const [albService] = await this.mustFindServices(['albService']);
                    await albService.decreaseAlbDependentWorkspaceCount(requestContext, projectId);
                }
                return await this.checkAndTerminateAlb(requestContext, projectId, externalId);
            } else {
                this.print({
                    msg: `Needs ALB Flag does not exists, skipping ALB termination`
                });
            }
        }, { attemptsCount: 600 });
    }

    /**
    * Method to check and terminate ALB if the environment is the last ALB dependent environment
    *
    * @param requestContext
    * @param projectId
    * @param externalId
    * @returns {Promise<>}
    */
    async checkAndTerminateAlb(requestContext, projectId, externalId) {
        const [albService] = await this.mustFindServices(['albService']);
        const count = await albService.albDependentWorkspacesCount(requestContext, projectId);
        const albExists = await albService.checkAlbExists(requestContext, projectId);
        if (count <= 0 && albExists) {
            this.print({
                msg: 'Last ALB Dependent workspace is being terminated. Terminating ALB'
            });
            const albDetails = await albService.getAlbDetails(requestContext, projectId);
            const albRecord = JSON.parse(albDetails.value);
            //Storing Dependency type so the stack termination can be handled for different dependencies
            this.state.setKey('DEPENDENCY_TYPE', 'ALB');
            return await this.terminateStack(requestContext, projectId, externalId, albRecord.albStackName);
        }
    }

    /**
    * Method to terminate a cfn stack
    *
    * @param requestContext
    * @param projectId
    * @param externalId
    * @param stackName
    * @returns {Promise<>}
    */
    async terminateStack(requestContext, projectId, externalId, stackName) {
        const cfn = await this.getCloudFormationService(requestContext, projectId, externalId);
        const params = {
            StackName: stackName
        };
        await cfn.deleteStack(params).promise();
        this.state.setKey('STACK_ID', stackName);
        return (
            this.wait(5) // check every 5 seconds
                // keep doing it for 1*1296000 seconds = 15 days
                // IMPORTANT: if you change the maxAttempts below or the wait check period of 5 seconds above
                // then make sure to adjust the error message in "reportTimeout" accordingly
                .maxAttempts(1296000)
                .until('shouldResumeWorkflow')
                .thenCall('onSuccessfulCompletion')
                .otherwiseCall('reportTimeout')
            // if anything fails, the "onFail" is called
        );
    }

    /**
    * Method to get the cloud formation service client for the target aws account
    *
    * @param requestContext
    * @param projectId
    * @param externalId
    * @return {Promise<>}
    */
    async getCloudFormationService(requestContext, projectId, externalId) {
        const [aws] = await this.mustFindServices(['aws']);
        const roleArn = await this.getTargetAccountRoleArn(requestContext, projectId);
        this.print({
            msg: `Creating AWS Cloudformation Client by assuming role = ${roleArn}`,
            roleArn,
        });
        // get service catalog client sdk with the service catalog admin role credentials
        const cfnClient = await aws.getClientSdkForRole({
            roleArn,
            clientName: 'CloudFormation',
            options: { apiVersion: '2015-12-10' },
            externalId,
        });
        return cfnClient;
    }

    /**
    * Method to get role arn for the target aws account
    *
    * @param requestContext
    * @param projectId
    * @returns {Promise<string>}
    */
    async getTargetAccountRoleArn(requestContext, projectId) {
        const [albService] = await this.mustFindServices(['albService']);
        const { roleArn } = await albService.findAwsAccountDetails(requestContext, projectId);
        return roleArn;
    }

    /**
    * Method to get CFT template output. The method gets CFT URL, read the CFT from S3
    * and parses the tmplate using js-yaml library
    *
    * @param requestContext
    * @param envTypeId
    * @returns {Promise<{Key: string:{Value: string, Description: string}}[]>}
    */
    async getTemplateOutputs(requestContext, envTypeId) {
        const { artifactInfo } = await this.describeArtifact(requestContext, envTypeId);
        const templateUrl = artifactInfo.TemplateUrl;
        const { bucketName, key } = await this.parseS3DetailsfromUrl(templateUrl);
        const templateBody = await this.getS3Object(bucketName, key);
        const templateBodyParsed = yaml.load(templateBody, { schema: jsYamlCustomSchema, json: true });
        const templateOutputs = _.get(templateBodyParsed, 'Outputs', {});
        return templateOutputs;
    }

    /**
    * Method to describe product artifact. The method gets service catalog client
    * and describes the product. returns the template URL
    *
    * @param requestContext
    * @param envTypeId
    * @returns {Promise<{artifactInfo: {}}[]>}
    */
    async describeArtifact(requestContext, envTypeId) {
        const [envTypeService, aws] = await this.mustFindServices(['envTypeService', 'aws']);
        const envType = await envTypeService.mustFind(requestContext, { id: envTypeId });
        const envMgmtRoleArn = this.settings.get(settingKeys.envMgmtRoleArn);
        const serviceCatalogClient = await getServiceCatalogClient(aws, envMgmtRoleArn);
        const params = {
            ProductId: envType.product.productId,
            ProvisioningArtifactId: envType.provisioningArtifact.id,
        };
        const { Info: artifactInfo } = await serviceCatalogClient.describeProvisioningArtifact(params).promise();
        return { artifactInfo };
    }

    /**
    * Method to read S3 object using S3 API
    *
    * @param bucketName
    * @param key
    * @returns {Promise<string>}
    */
    async getS3Object(bucketName, key) {
        const [aws] = await this.mustFindServices(['aws']);
        const s3Client = new aws.sdk.S3();
        const params = {
            Bucket: bucketName,
            Key: key,
        };
        const data = await s3Client.getObject(params).promise();
        return data.Body.toString('utf-8');
    }

    /**
    * Method to parse the S3 url for bucket name and key. Took parsing logic from the AWS Java SDK 
    * https://github.com/aws/aws-sdk-java/blob/master/aws-java-sdk-s3/src/main/java/com/amazonaws/services/s3/AmazonS3URI.java
    *
    * @param templateUrl
    * @returns {Promise<{bucketName:string, key:string}>}
    */
    async parseS3DetailsfromUrl(templateUrl) {
        const ENDPOINT_PATTERN = /^(.+\.)?s3[.-]([a-z0-9-]+)\./;
        const uri = url.parse(templateUrl);
        const matches = uri.host.match(ENDPOINT_PATTERN);
        if (!matches) {
            throw new Error(`Invalid S3 URI: ${uri}`);
        }
        const prefix = matches[1];
        //remove last . from prefix
        const bucketName = prefix.substring(0, prefix.length - 1);
        const key = uri.pathname.substring(1);
        return { bucketName, key }
    }

    /**
    * Method to converts Cfn outputs array to object
    *
    * @param outputs
    * @returns {Promise<{}>}
    */
    async cfnOutputsArrayToObject(outputs) {
        const outputsObject = {};
        _.forEach(outputs, output => {
            _.set(outputsObject, output.OutputKey, output.OutputValue);
        });
        return outputsObject;
    }

    /**
    * A method to decide when to resume the workflow.
    * This method checks for the status of the ALB being terminated and returns true when the
    * stack has completed successfully. If the stack encountered any errors, the method throws an
    * error.
    *
    * @returns {Promise<boolean>}
    */
    async shouldResumeWorkflow() {
        const [requestContext, externalId, projectId, stackId] = await Promise.all([
            this.payloadOrConfig.object(inPayloadKeys.requestContext),
            this.payloadOrConfig.string(inPayloadKeys.externalId),
            this.state.string('PROJECT_ID'),
            this.state.string('STACK_ID'),
        ]);
        const cfn = await this.getCloudFormationService(requestContext, projectId, externalId);
        const stackInfo = (await cfn.describeStacks({ StackName: stackId }).promise()).Stacks[0];

        if (_.includes(failureStatuses, stackInfo.StackStatus)) {
            // If termination failed then throw error, any unhandled workflow errors
            // are handled in "onFail" method
            throw new Error(`ALB Stack termination failed with message: ${stackInfo.StackStatusReason}`);
        }

        if (_.includes(successStatuses, stackInfo.StackStatus)) {
            // If the termination completed successfully then return true to resume workflow}
            return true;
        }
        // Return false to continue waiting for the product termination to complete
        return false;
    }

    /**
    * Method to perform tasks after the alb termination is completed successfully.
    * @returns {Promise<*>}
    */
    async onSuccessfulCompletion() {
        const [requestContext, projectId, dependencyType] = await Promise.all([
            this.payloadOrConfig.object(inPayloadKeys.requestContext),
            this.state.string('PROJECT_ID'),
            this.state.string('DEPENDENCY_TYPE'),
        ]);
        if (dependencyType == "ALB") {
            const [albService] = await this.mustFindServices(['albService']);
            const awsAccountId = await albService.findAwsAccountId(requestContext, projectId);
            const albDetails = {
                id: awsAccountId,
                albStackName: null,
                albArn: null,
                listenerArn: null,
                albDnsName: null,
                albDependentWorkspacesCount: 0
            }
            await albService.saveAlbDetails(awsAccountId, albDetails);
        }
        this.print({
            msg: `Dependency Details Updated Successfully`
        });
    }

    async reportTimeout() {
        const [envId, envName] = await Promise.all([
            this.payloadOrConfig.string(inPayloadKeys.envId),
            this.payloadOrConfig.string(inPayloadKeys.envName),
        ]);
        throw new Error(`Error terminating environment "${envName}" with id "${envId}". The workflow timed-out because the ALB CFT did not ` +
            `terminate within the timeout period of 15 days.`
        );
    }

    /**
    * Method to perform tasks upon some error. The method calls "onEnvTerminationFailure" method on plugins registered for the extension point "env-provisioning"
    * The method updates 
    * @returns {Promise<*>}
    */
    async onFail(error) {
        this.printError(error);
        //Add custom Error message
        error.message = "ALB Termination has failed with the folowing error. \
        Please contact your administrator. Retry the termination to terminate the workspace. Reason:" + error.message;
        const [requestContext, envId, projectId, dependencyType] = await Promise.all([
            this.payloadOrConfig.object(inPayloadKeys.requestContext),
            this.payloadOrConfig.string(inPayloadKeys.envId),
            this.state.string('PROJECT_ID'),
            this.state.optionalString('DEPENDENCY_TYPE'),
        ]);
        let record;

        if (dependencyType == "ALB") {
            const [albService] = await this.mustFindServices(['albService']);
            const awsAccountId = await albService.findAwsAccountId(requestContext, projectId);
            const albDetails = {
                id: awsAccountId,
                albStackName: null,
                albArn: null,
                listenerArn: null,
                albDnsName: null,
                albDependentWorkspacesCount: 0
            }
            await albService.saveAlbDetails(awsAccountId, albDetails);
        }
        this.print({
            msg: `Dependency Details Updated Successfully`
        });

        const [pluginRegistryService] = await this.mustFindServices(['pluginRegistryService']);

        // Give all plugins a chance to react (such as updating database etc) to environment creation having failed
        await pluginRegistryService.visitPlugins(pluginConstants.extensionPoint, 'onEnvTerminationFailure', {
            payload: {
                requestContext,
                container: this.container,
                status: environmentStatusEnum.TERMINATING_FAILED,
                error,
                envId,
                record,
            },
        });
    }
}

module.exports = TerminateLaunchDependency;