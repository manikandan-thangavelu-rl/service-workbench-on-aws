"use strict";

function _typeof(obj) { "@babel/helpers - typeof"; if (typeof Symbol === "function" && typeof Symbol.iterator === "symbol") { _typeof = function _typeof(obj) { return typeof obj; }; } else { _typeof = function _typeof(obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; }; } return _typeof(obj); }

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports["default"] = void 0;

var _lodash = _interopRequireDefault(require("lodash"));

var _react = _interopRequireDefault(require("react"));

var _mobxReact = require("mobx-react");

var _semanticUiReact = require("semantic-ui-react");

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { "default": obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

function _defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } }

function _createClass(Constructor, protoProps, staticProps) { if (protoProps) _defineProperties(Constructor.prototype, protoProps); if (staticProps) _defineProperties(Constructor, staticProps); return Constructor; }

function _inherits(subClass, superClass) { if (typeof superClass !== "function" && superClass !== null) { throw new TypeError("Super expression must either be null or a function"); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, writable: true, configurable: true } }); if (superClass) _setPrototypeOf(subClass, superClass); }

function _setPrototypeOf(o, p) { _setPrototypeOf = Object.setPrototypeOf || function _setPrototypeOf(o, p) { o.__proto__ = p; return o; }; return _setPrototypeOf(o, p); }

function _createSuper(Derived) { var hasNativeReflectConstruct = _isNativeReflectConstruct(); return function _createSuperInternal() { var Super = _getPrototypeOf(Derived), result; if (hasNativeReflectConstruct) { var NewTarget = _getPrototypeOf(this).constructor; result = Reflect.construct(Super, arguments, NewTarget); } else { result = Super.apply(this, arguments); } return _possibleConstructorReturn(this, result); }; }

function _possibleConstructorReturn(self, call) { if (call && (_typeof(call) === "object" || typeof call === "function")) { return call; } return _assertThisInitialized(self); }

function _assertThisInitialized(self) { if (self === void 0) { throw new ReferenceError("this hasn't been initialised - super() hasn't been called"); } return self; }

function _isNativeReflectConstruct() { if (typeof Reflect === "undefined" || !Reflect.construct) return false; if (Reflect.construct.sham) return false; if (typeof Proxy === "function") return true; try { Date.prototype.toString.call(Reflect.construct(Date, [], function () {})); return true; } catch (e) { return false; } }

function _getPrototypeOf(o) { _getPrototypeOf = Object.setPrototypeOf ? Object.getPrototypeOf : function _getPrototypeOf(o) { return o.__proto__ || Object.getPrototypeOf(o); }; return _getPrototypeOf(o); }

var WarningBox = /*#__PURE__*/function (_React$Component) {
  _inherits(WarningBox, _React$Component);

  var _super = _createSuper(WarningBox);

  function WarningBox() {
    var _this;

    _classCallCheck(this, WarningBox);

    for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
      args[_key] = arguments[_key];
    }

    _this = _super.call.apply(_super, [this].concat(args));

    _this.handleRetry = function () {
      Promise.resolve().then(function () {
        return _this.props.onRetry();
      })["catch"](function (_err) {
        /* ignore */
      });
    };

    return _this;
  }

  _createClass(WarningBox, [{
    key: "render",
    value: function render() {
      var defaultMessage = 'Hmm... something is needing your attention';
      var rawMessage = this.props.warning || defaultMessage;
      var message = _lodash["default"].isString(rawMessage) ? rawMessage : _lodash["default"].get(rawMessage, 'message', defaultMessage);

      var shouldRetry = _lodash["default"].isFunction(this.props.onRetry);

      return /*#__PURE__*/_react["default"].createElement("div", {
        className: "p3"
      }, /*#__PURE__*/_react["default"].createElement(_semanticUiReact.Message, {
        warning: true,
        className: "mt2 mb2 clearfix"
      }, /*#__PURE__*/_react["default"].createElement(_semanticUiReact.Message.Header, null, "Warning"), /*#__PURE__*/_react["default"].createElement("p", null, message), shouldRetry && /*#__PURE__*/_react["default"].createElement(_semanticUiReact.Button, {
        floated: "right",
        basic: true,
        color: "brown",
        onClick: this.handleRetry
      }, "Retry")));
    }
  }]);

  return WarningBox;
}(_react["default"].Component);

var _default = (0, _mobxReact.observer)(WarningBox);

exports["default"] = _default;
//# sourceMappingURL=WarningBox.js.map