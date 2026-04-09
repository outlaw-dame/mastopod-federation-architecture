import { withRetry } from "./utils.js";
import type { MRFAdminDeps } from "./types.js";

const MAX_SIMULATION_MS = 5000;

export async function runSimulationJob(jobId: string, deps: MRFAdminDeps): Promise<void> {
  const job = await deps.store.getSimulationJob(jobId);
  if (!job || job.status !== "queued") return;

  job.status = "running";
  job.updatedAt = deps.now();
  await deps.store.createSimulationJob(job);

  try {
    await Promise.race([
      runSimulation(jobId, deps),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Simulation timed out")), MAX_SIMULATION_MS);
      }),
    ]);
  } catch (err) {
    const failed = await deps.store.getSimulationJob(jobId);
    if (!failed) return;
    failed.status = "failed";
    failed.updatedAt = deps.now();
    failed.error = String((err as Error)?.message || err);
    await deps.store.createSimulationJob(failed);
  }
}

async function runSimulation(jobId: string, deps: MRFAdminDeps): Promise<void> {
  const job = await deps.store.getSimulationJob(jobId);
  if (!job) return;

  // Placeholder payload fetch path. Use withRetry when reading upstream activity by activityId.
  if (job.activityId) {
    await withRetry(
      async () => {
        return { id: job.activityId };
      },
      { retries: 3, baseMs: 100, maxMs: 1000 },
    );
  }

  job.status = "completed";
  job.updatedAt = deps.now();
  job.result = {
    traces: [],
    finalAction: "accept",
  };
  await deps.store.createSimulationJob(job);
}
