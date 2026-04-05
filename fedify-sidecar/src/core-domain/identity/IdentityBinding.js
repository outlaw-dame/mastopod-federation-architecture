"use strict";
/**
 * V6.5 Identity Binding - Authoritative Dual-Protocol Identity Model
 *
 * This is the canonical representation of a dual-protocol identity that bridges
 * ActivityPub and ATProto. It serves as the source of truth for all identity-related
 * operations across both protocols.
 *
 * Key Invariants:
 * - atRotationKeyRef must never equal atSigningKeyRef in production policy
 * - plc.rotationKeyRef mirrors atRotationKeyRef
 * - canonicalDidMethod determines which mutation path is used
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.IdentityBindingValidation = void 0;
/**
 * Validation helpers
 */
exports.IdentityBindingValidation = {
    /**
     * Validate that rotation and signing keys are different
     */
    validateKeyDistinctness: function (binding) {
        if (!binding.atRotationKeyRef || !binding.atSigningKeyRef) {
            return true; // Not yet provisioned
        }
        return binding.atRotationKeyRef !== binding.atSigningKeyRef;
    },
    /**
     * Validate that PLC rotation key mirrors AT rotation key
     */
    validatePlcKeyMirror: function (binding) {
        if (!binding.plc) {
            return true; // Not a PLC binding
        }
        if (!binding.atRotationKeyRef) {
            return binding.plc.rotationKeyRef === null;
        }
        return binding.plc.rotationKeyRef === binding.atRotationKeyRef;
    },
    /**
     * Validate that DID method is consistent with state
     */
    validateDidMethodConsistency: function (binding) {
        if (!binding.canonicalDidMethod) {
            return binding.plc === null && binding.didWeb === null;
        }
        if (binding.canonicalDidMethod === 'did:plc') {
            return binding.plc !== null && binding.didWeb === null;
        }
        if (binding.canonicalDidMethod === 'did:web') {
            return binding.plc === null && binding.didWeb !== null;
        }
        return false;
    },
    /**
     * Full validation
     */
    validate: function (binding) {
        var errors = [];
        if (!this.validateKeyDistinctness(binding)) {
            errors.push('AT rotation key must differ from signing key');
        }
        if (!this.validatePlcKeyMirror(binding)) {
            errors.push('PLC rotation key must mirror AT rotation key');
        }
        if (!this.validateDidMethodConsistency(binding)) {
            errors.push('DID method state is inconsistent');
        }
        return {
            valid: errors.length === 0,
            errors: errors,
        };
    },
};
