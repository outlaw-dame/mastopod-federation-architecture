"use strict";
/**
 * V6.5 Identity Binding Repository - Data Access Interface
 *
 * Defines the contract for persisting and retrieving identity bindings.
 * Implementations can use various backends (Fuseki/SPARQL, PostgreSQL, etc.)
 *
 * This interface is designed to support efficient lookups by all key identifiers:
 * - Canonical account ID (primary key)
 * - ATProto DID
 * - ATProto handle
 * - ActivityPub actor URI
 */
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.RepositoryError = exports.RepositoryErrorCode = void 0;
/**
 * Repository error codes
 */
var RepositoryErrorCode;
(function (RepositoryErrorCode) {
    /**
     * Identity binding not found
     */
    RepositoryErrorCode["NOT_FOUND"] = "NOT_FOUND";
    /**
     * Duplicate key constraint violation
     */
    RepositoryErrorCode["DUPLICATE"] = "DUPLICATE";
    /**
     * Validation error
     */
    RepositoryErrorCode["VALIDATION_ERROR"] = "VALIDATION_ERROR";
    /**
     * Persistence error
     */
    RepositoryErrorCode["PERSISTENCE_ERROR"] = "PERSISTENCE_ERROR";
    /**
     * Conflict during update
     */
    RepositoryErrorCode["CONFLICT"] = "CONFLICT";
    /**
     * Query error
     */
    RepositoryErrorCode["QUERY_ERROR"] = "QUERY_ERROR";
})(RepositoryErrorCode || (exports.RepositoryErrorCode = RepositoryErrorCode = {}));
/**
 * Repository error
 */
var RepositoryError = /** @class */ (function (_super) {
    __extends(RepositoryError, _super);
    function RepositoryError(code, message, details) {
        var _this = _super.call(this, message) || this;
        _this.code = code;
        _this.details = details;
        _this.name = 'RepositoryError';
        return _this;
    }
    return RepositoryError;
}(Error));
exports.RepositoryError = RepositoryError;
