# APDM Status

Last updated: 2026-08-13

## Phase status

| Phase | ActivityPods slice | Federation slice | Gate |
|---|---|---|---|
| APDM-P0 | PR #13 merged | PR #8 merged | PASS |
| APDM-P1 | PR #14 merged; hardening PR #23 merged | PR #9 merged; hardening PR #18 merged | PASS |
| APDM-P2 | PR #15 merged; hardening PR #22 merged | PR #10 merged; hardening PR #16 merged | PASS |
| APDM-P3 | PR #16 merged; hardening PR #21 merged | PR #11 merged; hardening PR #14 merged | PASS |
| APDM-P4 | PR #17 merged | PR #12 merged | PASS |
| APDM-P5 | active planning | active planning | IN PROGRESS |
| APDM-P6 | not started | not started | blocked by P5 |
| APDM-P7–P13 | not started | as needed | blocked by remote-authority stabilization |

## Phase 5 current state

PR #26 tracks the remote-authority cutover. Runtime changes remain gated by:

- outbound HTTP SSRF protection proof;
- ActivityPods native rollback preservation;
- Fedify-only external execution proof;
- ActivityPub interoperability coverage.

Phase 5 is not complete and external authority cutover is not enabled.
