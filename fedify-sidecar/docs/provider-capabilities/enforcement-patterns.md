# Capability Enforcement Patterns

This document defines shared enforcement behavior so entitlement and capability gates are consistent in:

1. HTTP request path
2. background workers
3. event subscription authorization

## Design Principle

One resolver computes an effective capability context. Every execution surface consumes that same context.

## Shared Types

```ts
export type CapabilityStatus = 'enabled' | 'disabled' | 'beta' | 'deprecated';

export interface EffectiveCapability {
  id: string;
  status: CapabilityStatus;
  limits: Record<string, string | number | boolean>;
}

export interface EffectiveCapabilityContext {
  providerId: string;
  profile: 'ap-core' | 'ap-scale' | 'dual-protocol-standard';
  protocol: {
    activitypub: boolean;
    atproto: boolean;
  };
  capabilities: Map<string, EffectiveCapability>;
}

export interface CapabilityGateResult {
  allowed: boolean;
  capabilityId: string;
  reasonCode?: 'feature_disabled' | 'limit_exceeded' | 'protocol_disabled';
  message?: string;
  retryable?: boolean;
}
```

## Resolver Pattern

```ts
export async function resolveEffectiveCapabilities(input: {
  providerId: string;
  tenantId?: string;
  plan: string;
  requestedProfile: 'ap-core' | 'ap-scale' | 'dual-protocol-standard';
}): Promise<EffectiveCapabilityContext> {
  const profileDefaults = await loadProfileDefaults(input.requestedProfile);
  const planEntitlements = await loadPlanEntitlements(input.plan);
  const tenantOverrides = input.tenantId ? await loadTenantOverrides(input.tenantId) : [];

  const merged = mergeCapabilities(profileDefaults, planEntitlements, tenantOverrides);
  const validation = validateCapabilityConfig(merged);

  if (!validation.ok) {
    const fatal = validation.issues.filter((x) => x.severity === 'fatal');
    if (fatal.length > 0) {
      throw new Error(`Invalid capability config: ${fatal[0].code}`);
    }
  }

  return merged;
}
```

## HTTP Middleware Pattern

```ts
export function requireCapability(capabilityId: string) {
  return async function capabilityGate(req, res, next) {
    const context = await req.services.capabilityContextResolver.resolve(req);
    const gate = evaluateCapabilityGate(context, capabilityId, req);

    if (!gate.allowed) {
      return res.status(403).json({
        error: gate.reasonCode ?? 'feature_disabled',
        message: gate.message ?? `Capability ${capabilityId} is disabled for this provider profile`,
        capabilityId,
        providerProfile: context.profile,
        retryable: gate.retryable ?? false,
      });
    }

    return next();
  };
}
```

### Example Route Mapping

- AP ingress route -> `requireCapability('ap.federation.ingress')`
- AP egress webhook route -> `requireCapability('ap.federation.egress')`
- AT XRPC repo writes -> `requireCapability('at.xrpc.repo')`

In AP-only profiles, AT gates must reject with the deterministic `feature_disabled` contract.

## Worker Guard Pattern

```ts
export async function guardWorkerJob(job, ctx: EffectiveCapabilityContext): Promise<CapabilityGateResult> {
  const capabilityId = mapJobToCapability(job);
  const gate = evaluateCapabilityGate(ctx, capabilityId, { jobType: job.type });

  if (!gate.allowed) {
    await moveToDlq(job, {
      code: gate.reasonCode ?? 'feature_disabled',
      capabilityId,
      profile: ctx.profile,
    });
  }

  return gate;
}
```

Rules:

- Worker MUST re-check capability at execution time (not only enqueue time).
- Disabled capability jobs MUST not be silently dropped.
- DLQ metadata MUST include `capabilityId`, `profile`, and `reasonCode`.

## Event Subscription Authorization Pattern

```ts
export async function authorizeEventSubscription(input: {
  consumerId: string;
  topic: string;
  context: EffectiveCapabilityContext;
}): Promise<CapabilityGateResult> {
  const capabilityId = mapTopicToCapability(input.topic);
  return evaluateCapabilityGate(input.context, capabilityId, { topic: input.topic });
}
```

Rules:

- Subscription authorization must enforce capability and entitlement limits.
- Denials must return stable machine-readable reason codes.
- Replay privileges should be evaluated separately from subscribe privileges.

## Gate Evaluation Pattern

```ts
export function evaluateCapabilityGate(
  context: EffectiveCapabilityContext,
  capabilityId: string,
  runtimeInput: Record<string, unknown>
): CapabilityGateResult {
  const capability = context.capabilities.get(capabilityId);

  if (!capability || capability.status === 'disabled') {
    return {
      allowed: false,
      capabilityId,
      reasonCode: 'feature_disabled',
      message: `Capability ${capabilityId} is disabled for profile ${context.profile}`,
      retryable: false,
    };
  }

  if (capabilityId.startsWith('at.') && !context.protocol.atproto) {
    return {
      allowed: false,
      capabilityId,
      reasonCode: 'protocol_disabled',
      message: 'ATProto protocol is disabled by provider policy',
      retryable: false,
    };
  }

  const limitIssue = evaluateLimits(capability, runtimeInput);
  if (limitIssue) {
    return {
      allowed: false,
      capabilityId,
      reasonCode: 'limit_exceeded',
      message: limitIssue,
      retryable: true,
    };
  }

  return { allowed: true, capabilityId };
}
```

## Observability Requirements

Every denial should emit:

- counter: `capability_gate_denied_total{capabilityId, profile, reasonCode, surface}`
- structured log fields: `capabilityId`, `profile`, `reasonCode`, `surface`, `tenantId`
- optional trace span attribute: `capability.gate.result=denied`

## AP-Only Compliance Checks

1. AT routes uniformly denied with `feature_disabled` or `protocol_disabled`.
2. AT worker job types are either not scheduled or moved to DLQ with explicit reason.
3. AT event subscriptions denied deterministically.
4. AP routes and workers continue operating normally under `ap-core`/`ap-scale`.
