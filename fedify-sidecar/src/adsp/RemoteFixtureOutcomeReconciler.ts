import type {
  AdspControlledRemoteScenario,
  ControlledTargetObservation,
  ControlledTargetSnapshot,
} from "./ControlledActivityPubTarget.js";

export interface AdspRemoteDurableOutcome {
  outboxIntentCompleted: boolean;
  outboxIntentJobCount: number | null;
  deliveryCompleted: boolean;
  /**
   * Change in the outbound DLQ length across this isolated fixture case.
   * Fixture orchestration must record the baseline immediately before enqueue.
   */
  outboundDlqDelta: number;
  /**
   * Queue-wide outbound pending count after the isolated fixture case settles.
   * The fixture owns the queue namespace, so a non-zero count is contradictory.
   */
  outboundPendingCount: number;
}

export interface AdspRemoteFixtureExpectation {
  scenario: AdspControlledRemoteScenario;
  activityId: string;
  transientFailuresBeforeSuccess?: number;
}

export interface AdspRemoteFixtureReconciliation {
  complete: boolean;
  scenario: AdspControlledRemoteScenario;
  activityId: string;
  observedBodySha256: string | null;
  observedRequests: number;
  errors: string[];
}

function observationsForActivity(
  snapshot: ControlledTargetSnapshot,
  scenario: AdspControlledRemoteScenario,
  activityId: string,
): ControlledTargetObservation[] {
  return snapshot.observations
    .filter(observation =>
      observation.scenario === scenario && observation.activityId === activityId,
    )
    .sort((left, right) => left.sequence - right.sequence);
}

function assertExactAttempts(
  observations: ControlledTargetObservation[],
  expectedRequests: number,
  errors: string[],
): void {
  if (observations.length !== expectedRequests) {
    errors.push(
      `expected exactly ${expectedRequests} remote request(s), observed ${observations.length}`,
    );
    return;
  }

  const bodyHashes = new Set(observations.map(observation => observation.bodySha256));
  if (bodyHashes.size > 1) {
    errors.push("remote retries did not preserve immutable ActivityPub body bytes");
  }

  for (let index = 0; index < observations.length; index += 1) {
    const expectedAttempt = index + 1;
    const observation = observations[index];
    if (!observation) continue;
    if (observation.payloadAttempt !== expectedAttempt) {
      errors.push(
        `payload attempt sequence is not contiguous: expected ${expectedAttempt}, observed ${observation.payloadAttempt}`,
      );
    }
    if (!observation.hasDate || !observation.hasDigest || !observation.hasSignature) {
      errors.push(`remote request ${expectedAttempt} is missing required signing headers`);
    }
    if (!observation.hasValidDigest) {
      errors.push(`remote request ${expectedAttempt} has a Digest that does not match the exact delivered body`);
    }
  }
}

function assertCommonDurableState(
  durable: AdspRemoteDurableOutcome,
  errors: string[],
): void {
  if (!durable.outboxIntentCompleted) {
    errors.push("outbox intent is not durably completed");
  }
  if (durable.outboxIntentJobCount !== 1) {
    errors.push(
      `expected outbox intent jobCount=1, observed ${String(durable.outboxIntentJobCount)}`,
    );
  }
  if (!Number.isSafeInteger(durable.outboundDlqDelta) || durable.outboundDlqDelta < 0) {
    errors.push("outboundDlqDelta must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(durable.outboundPendingCount) || durable.outboundPendingCount < 0) {
    errors.push("outboundPendingCount must be a non-negative safe integer");
  } else if (durable.outboundPendingCount !== 0) {
    errors.push(
      `expected no pending outbound entries in isolated fixture queue, observed ${durable.outboundPendingCount}`,
    );
  }
}

export function reconcileAdspRemoteFixtureOutcome(input: {
  expectation: AdspRemoteFixtureExpectation;
  target: ControlledTargetSnapshot;
  durable: AdspRemoteDurableOutcome;
}): AdspRemoteFixtureReconciliation {
  const { expectation, target, durable } = input;
  const errors: string[] = [];
  if (!expectation.activityId || expectation.activityId !== expectation.activityId.trim()) {
    errors.push("activityId must be a non-empty exact string");
  }
  const observations = observationsForActivity(
    target,
    expectation.scenario,
    expectation.activityId,
  );

  if (target.droppedObservations !== 0) {
    errors.push(
      `controlled target dropped ${target.droppedObservations} observation(s); exact reconciliation is impossible`,
    );
  }
  if (target.totalRequests !== observations.length) {
    errors.push(
      `isolated controlled target observed ${target.totalRequests} total request(s), but only ${observations.length} belong to the expected Activity/scenario`,
    );
  }

  assertCommonDurableState(durable, errors);

  if (expectation.scenario === "success") {
    assertExactAttempts(observations, 1, errors);
    if (!durable.deliveryCompleted) {
      errors.push("successful remote delivery is missing its durable completed marker");
    }
    if (durable.outboundDlqDelta !== 0) {
      errors.push(
        `successful remote delivery unexpectedly changed outbound DLQ by ${durable.outboundDlqDelta}`,
      );
    }
  } else if (expectation.scenario === "transient") {
    const failures = expectation.transientFailuresBeforeSuccess
      ?? target.transientFailuresBeforeSuccess;
    if (!Number.isSafeInteger(failures) || failures < 0) {
      errors.push("transientFailuresBeforeSuccess must be a non-negative safe integer");
    } else {
      assertExactAttempts(observations, failures + 1, errors);
    }
    if (!durable.deliveryCompleted) {
      errors.push("transient-then-success delivery is missing its durable completed marker");
    }
    if (durable.outboundDlqDelta !== 0) {
      errors.push(
        `transient-then-success delivery unexpectedly changed outbound DLQ by ${durable.outboundDlqDelta}`,
      );
    }
  } else {
    assertExactAttempts(observations, 1, errors);
    if (durable.deliveryCompleted) {
      errors.push("permanent failure must not have a durable completed-delivery marker");
    }
    if (durable.outboundDlqDelta !== 1) {
      errors.push(
        `expected permanent failure to increase outbound DLQ by exactly 1, observed delta ${durable.outboundDlqDelta}`,
      );
    }
  }

  return {
    complete: errors.length === 0,
    scenario: expectation.scenario,
    activityId: expectation.activityId,
    observedBodySha256: observations[0]?.bodySha256 ?? null,
    observedRequests: observations.length,
    errors,
  };
}
