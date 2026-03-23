# ActivityPub MRF Specification Analysis

## Source
https://aumetra.xyz/posts/activitypub-mrf/

## Key Concepts

### What is MRF?
- **M**essage **R**ewrite **F**acility
- ActivityPub-aware middleware for incoming/outgoing activities
- Can modify, reject, or accept activities
- Originated in Pleroma (Elixir-based)

### Core Interface (WIT Specification)

```
package fep:mrf@0.1.0;

interface types {
    enum direction {
        incoming,    // Activity being received
        outgoing,    // Activity being sent out
    }

    enum outcome {
        accept(string),    // Activity accepted (possibly modified)
        reject,            // Activity rejected
    }

    variant error {
        error-continue(string),  // Non-fatal error, continue processing
        error-reject(string),    // Fatal error, stop processing
    }
}

world mrf {
    export transform: func(direction: direction, activity: string) -> result<outcome, error>;
}
```

### Key Features

1. **Direction Context**: Policies can behave differently for incoming vs outgoing
2. **Error Handling**: Distinguishes between recoverable and fatal errors
3. **Activity Modification**: Can transform activities, not just accept/reject
4. **WebAssembly-based**: Language-agnostic via Wasm bytecode

### Implementation Approach

**Two viable solutions:**

1. **Extism** (JSON/MessagePack encoding)
   - Pros: Works with multiple host languages
   - Cons: Serialization overhead

2. **Component Model** (WIT-based)
   - Pros: Lower overhead, type-safe contracts
   - Cons: Currently Rust-only hosts (workarounds exist)

The specification recommends **Component Model** for the long term.

### Configuration

- Modules need to be configurable without recompilation
- Host should handle configuration loading
- Admin should be able to modify policies without rebuilding

## Implications for V6 Sidecar

### Current V6 MRF Implementation

The current `mrf-runtime.ts` is a **simplified in-process implementation** that:
- ✅ Supports multiple policies
- ✅ Handles rejection with audit trail
- ✅ Distinguishes incoming/outgoing
- ❌ Does NOT use WebAssembly
- ❌ Does NOT support external policy modules
- ❌ Policies are hardcoded

### Alignment Gap

**V6 Current:** In-process TypeScript policies (Pleroma v1 style)
**MRF Spec:** WebAssembly-based extensible policies (Pleroma v2+ style)

### Recommended Path

**Phase 1 (Current V6):** 
- Keep in-process TypeScript MRF for MVP
- Provides core functionality: pre-accept filtering, rejection audit
- Sufficient for basic federation

**Phase 2 (Future):**
- Migrate to WebAssembly-based MRF (Component Model)
- Support external policy modules
- Enable admin configuration without recompilation
- Support Rust, Go, Haskell, etc. for policy development

## MRF Policies for V6

Based on the spec, V6 should support:

### Built-in Policies (In-Process)

1. **Signature Validation** (incoming only)
   - Verify HTTP signatures before accepting
   - Direction: incoming

2. **Blocked Domain** (both directions)
   - Reject activities from/to blocked domains
   - Direction: incoming, outgoing
   - Configurable: domain list

3. **Suspicious Activity** (incoming)
   - Detect malformed or oversized activities
   - Direction: incoming
   - Configurable: size limits, type restrictions

4. **Rate Limiting** (outgoing)
   - Limit delivery rate per domain
   - Direction: outgoing
   - Configurable: requests per window

5. **Content Filter** (incoming)
   - Reject based on content patterns
   - Direction: incoming
   - Configurable: regex patterns, keywords

### Future: WebAssembly Policies

- Custom policies written in any Wasm-compatible language
- Loaded from external modules
- Configurable via JSON/YAML
- Versioned and signed

## Integration Points

### Inbound Path
```
HTTP Request
    ↓
Signature Verification (MRF policy)
    ↓
Blocked Domain Check (MRF policy)
    ↓
Content Filtering (MRF policy)
    ↓
Actor Fetching
    ↓
Forward to ActivityPods
```

### Outbound Path
```
ActivityPods emits ap.outbound.v1
    ↓
Rate Limiting Check (MRF policy)
    ↓
Blocked Domain Check (MRF policy)
    ↓
Request Signature
    ↓
Deliver to Remote Inbox
```

## Recommendations for V6

### Short Term (MVP)
- ✅ Keep current in-process TypeScript MRF
- ✅ Implement core policies (signature, blocked-domain, suspicious)
- ✅ Emit rejection audit to `ap.mrf.rejected.v1`
- ✅ Support policy enable/disable flags

### Medium Term
- Add WebAssembly runtime (Wasmtime or Extism)
- Create WIT interface for MRF policies
- Support external policy modules
- Add configuration file support

### Long Term
- Standardize on Component Model (when multi-language support available)
- Build policy marketplace/registry
- Support hot-reloading of policies
- Add policy composition and chaining

## Current V6 Implementation Status

**Implemented:**
- ✅ `MrfRuntime` class with policy execution
- ✅ `SignatureValidationPolicy`
- ✅ `BlockedDomainPolicy`
- ✅ `SuspiciousActivityPolicy`
- ✅ Rejection audit emission
- ✅ Direction context (incoming/outgoing)

**Not Yet Implemented:**
- ❌ WebAssembly support
- ❌ External policy modules
- ❌ Configuration files
- ❌ Policy composition
- ❌ Hot-reloading

**Recommended Next Steps:**
1. Test current policies with real federation
2. Add more built-in policies (content filter, rate limiting)
3. Implement configuration file support
4. Add WebAssembly runtime (Phase 2)
