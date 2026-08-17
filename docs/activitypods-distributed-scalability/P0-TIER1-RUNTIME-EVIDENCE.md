# ADSP P0 Tier-1 Runtime Evidence

Status: **COMPLETE for Fixture A / local Tier-1 scope only**

This document records the first completed runtime evidence fixture for ADSP-P0. It does **not** complete ADSP-P0 by itself and it is not whole-system federation evidence. The separate ActivityPods-originating remote Fixture B remains required.

## Provenance

- ActivityPods workflow: `ADSP P0 Tier-1 baseline`
- workflow run: `32070748744`
- exact ActivityPods commit executed: `306e718b3d29a78f032d0545a0c66c22d533bb1f`
- artifact: `adsp-p0-tier1-32070748744-1`
- artifact digest: `sha256:e6975cfa3d2d1bdfc63142c0ac7be2f2ed92b9460ff198fe0b182bd1bcd4c6b8`
- measured samples: 5 per recipient count, 25 total
- failed measured samples: 0
- warmups: 1 per recipient count
- recipient counts: `1, 10, 100, 200, 1000`
- local delivery concurrency: `4`
- Phase-10 dataset-existence memo: **OFF** (current production default)
- ActivityPub remote delivery mode: `native`
- federation sidecar: **excluded by fixture design**
- `wholeSystemEvidence`: **false**

The evidence summarizer marked the set `complete: true` with no incomplete cases.

## Results

| recipients | samples | elapsed p50 ms | elapsed CV | CPU p50 ms | Fuseki requests p50 | elapsed p50 / recipient ms |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 5 | 1,488.60 | 170.28% | 1,371.71 | 336 | 1,488.60 |
| 10 | 5 | 2,618.41 | 3.85% | 2,723.23 | 601 | 261.84 |
| 100 | 5 | 21,817.83 | 3.22% | 21,694.29 | 3,351 | 218.18 |
| 200 | 5 | 42,897.69 | 1.04% | 42,261.22 | 6,445 | 214.49 |
| 1000 | 5 | 259,864.56 | 3.38% | 245,081.23 | 31,265 | 259.86 |

## Interpretation boundary

The `N=1` case is **not stable enough for comparative latency conclusions**. Its elapsed-time coefficient of variation is about 170%, including a large tail outlier. It remains in the artifact because it is part of the frozen canonical matrix, but candidate promotion must not use that single-recipient value as a precise baseline.

The `N=10` through `N=1000` cases are substantially more stable in this run, with elapsed-time CV around 1–4%. They show that the current colocated Tier-1 path carries large CPU and Fuseki work as recipient count rises. This fixture alone does not attribute that work to the Moleculer transporter and must not be used to claim that NATS, Redis transport, or remote service distribution will improve it.

The roughly linear growth in Fuseki request counts remains consistent with the existing APDM/ADSP concern about nested local semantic work. The program therefore continues to protect Tier-1 locality and requires attribution before distributing tightly coupled services.

## What this fixture proves

This completed fixture establishes a repeatable local-cell baseline for:

- real ActivityPods account provisioning/bootstrap;
- real `activitypub.outbox.post` execution;
- local ActivityPub fanout through the current SemApps/LDP/WebACL/triplestore/Fuseki path;
- CPU, elapsed-time, memory/runtime snapshots and Redis command/memory snapshots;
- current-default Phase-10 memo behavior with memo disabled;
- variance/completeness enforcement across the canonical recipient matrix.

## What this fixture does not prove

It does not include or measure:

- the Fedify sidecar;
- authoritative external Delivery Plan handoff;
- sidecar Redis Streams delivery work;
- RedPanda event logging;
- ActivityPods signing API calls for remote HTTP;
- remote HTTP success/retry/DLQ behavior;
- Redis-versus-NATS transporter comparison;
- multi-node Moleculer correctness, locality or failure/rejoin behavior.

Those remain separate P0/P1+ gates. In particular, **ADSP-P0 remains IN PROGRESS** until the required remote/whole-system and distributed-safety evidence is complete.
