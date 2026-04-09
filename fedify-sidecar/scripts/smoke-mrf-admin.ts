/*
 * MRF Admin API smoke verifier
 *
 * Requires:
 *   - ENABLE_MRF_ADMIN_API=true on running sidecar
 *   - MRF_ADMIN_TOKEN in environment for this script
 *
 * Optional env:
 *   - MRF_ADMIN_BASE_URL (default: http://localhost:8080)
 *   - MRF_SMOKE_SIM_POLL_MAX_ATTEMPTS (default: 8)
 *   - MRF_SMOKE_SIM_POLL_BASE_MS (default: 200)
 *   - MRF_SMOKE_SIM_POLL_MAX_MS (default: 2000)
 */

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

interface ApiError {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
    requestId?: string;
  };
}

interface ModulesResponse {
  data: Array<{
    manifest: { id: string };
    config: { revision: number; mode: string } | null;
  }>;
}

interface RegistryListResponse {
  data: Array<{
    manifest: { id: string };
    config: {
      fields: Array<{ key: string }>;
      defaults: Record<string, JsonValue>;
    };
  }>;
}

interface RegistryItemResponse {
  data: {
    manifest: { id: string };
    ui: { category: string };
    config: {
      fields: Array<{ key: string }>;
      defaults: Record<string, JsonValue>;
    };
  };
}

interface ChainResponse {
  data: {
    revision: number;
    modules: Array<{ id: string; priority: number; enabled: boolean }>;
  };
}

interface TraceListResponse {
  data: Array<Record<string, JsonValue>>;
  nextCursor?: string;
}

interface SimulationCreateResponse {
  data: {
    jobId: string;
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
  };
}

interface SimulationGetResponse {
  data: {
    jobId: string;
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    error?: string;
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function getArgValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function backoffPoll<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts: number;
    baseMs: number;
    maxMs: number;
    shouldStop: (result: T) => boolean;
  },
): Promise<T> {
  let attempt = 0;
  let lastResult: T | null = null;

  while (attempt < opts.maxAttempts) {
    const result = await fn();
    lastResult = result;
    if (opts.shouldStop(result)) return result;

    const backoff = Math.min(opts.maxMs, opts.baseMs * 2 ** attempt);
    const jitter = Math.floor(Math.random() * Math.max(25, Math.floor(backoff / 3)));
    await sleep(backoff + jitter);
    attempt += 1;
  }

  if (lastResult !== null) return lastResult;
  throw new Error("No poll result captured");
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: T | ApiError | null }> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!text) {
    return { status: response.status, body: null };
  }

  try {
    return { status: response.status, body: JSON.parse(text) as T | ApiError };
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 200)}`);
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function authHeaders(token: string, permissions: string, actor = "smoke:tester"): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    "x-provider-permissions": permissions,
    "x-provider-actor": actor,
    "x-request-id": `smoke-${Date.now()}`,
    "content-type": "application/json",
  };
}

async function main(): Promise<void> {
  const baseUrl = (getArgValue("--base-url") || process.env["MRF_ADMIN_BASE_URL"] || "http://localhost:8080").replace(/\/$/, "");
  const token = getArgValue("--token") || process.env["MRF_ADMIN_TOKEN"] || "";
  if (!token) {
    throw new Error("MRF_ADMIN_TOKEN is required (env or --token <value>)");
  }
  const maxAttempts = parseIntEnv("MRF_SMOKE_SIM_POLL_MAX_ATTEMPTS", 8);
  const baseMs = parseIntEnv("MRF_SMOKE_SIM_POLL_BASE_MS", 200);
  const maxMs = parseIntEnv("MRF_SMOKE_SIM_POLL_MAX_MS", 2000);

  console.log(`[smoke] target=${baseUrl}`);

  const unauthorized = await requestJson<ApiError>(
    `${baseUrl}/internal/admin/mrf/modules`,
    { method: "GET", headers: authHeaders("wrong-token", "provider:read") },
  );
  assert(unauthorized.status === 401, `expected 401 for unauthorized request, got ${unauthorized.status}`);

  const forbidden = await requestJson<ApiError>(
    `${baseUrl}/internal/admin/mrf/modules`,
    { method: "GET", headers: authHeaders(token, "provider:write") },
  );
  assert(forbidden.status === 403, `expected 403 for missing read permission, got ${forbidden.status}`);

  const modules = await requestJson<ModulesResponse>(
    `${baseUrl}/internal/admin/mrf/modules`,
    { method: "GET", headers: authHeaders(token, "provider:read") },
  );
  assert(modules.status === 200, `modules list failed with status ${modules.status}`);
  assert(modules.body && "data" in modules.body, "modules response missing data");
  const moduleItems = (modules.body as ModulesResponse).data;
  assert(Array.isArray(moduleItems), "modules data is not an array");
  assert(moduleItems.length > 0, "modules list is empty");

  const registryList = await requestJson<RegistryListResponse>(
    `${baseUrl}/internal/admin/mrf/registry`,
    { method: "GET", headers: authHeaders(token, "provider:read") },
  );
  assert(registryList.status === 200, `registry list failed with status ${registryList.status}`);
  assert(registryList.body && "data" in registryList.body, "registry list missing data");
  const registryItems = (registryList.body as RegistryListResponse).data;
  assert(Array.isArray(registryItems), "registry list data is not an array");
  assert(registryItems.length > 0, "registry list is empty");
  const firstRegistryModuleId = registryItems[0]?.manifest?.id;
  assert(typeof firstRegistryModuleId === "string" && firstRegistryModuleId.length > 0, "registry module id missing");

  const registryItem = await requestJson<RegistryItemResponse>(
    `${baseUrl}/internal/admin/mrf/registry/${encodeURIComponent(firstRegistryModuleId)}`,
    { method: "GET", headers: authHeaders(token, "provider:read") },
  );
  assert(registryItem.status === 200, `registry item failed with status ${registryItem.status}`);
  assert(registryItem.body && "data" in registryItem.body, "registry item missing data");
  const registryPayload = (registryItem.body as RegistryItemResponse).data;
  assert(registryPayload.manifest.id === firstRegistryModuleId, "registry item id mismatch");
  assert(Array.isArray(registryPayload.config.fields), "registry fields are missing");
  assert(registryPayload.config.fields.length > 0, "registry fields should not be empty");

  const chain = await requestJson<ChainResponse>(
    `${baseUrl}/internal/admin/mrf/chain`,
    { method: "GET", headers: authHeaders(token, "provider:read") },
  );
  assert(chain.status === 200, `chain get failed with status ${chain.status}`);
  assert(chain.body && "data" in chain.body, "chain response missing data");

  const traces = await requestJson<TraceListResponse>(
    `${baseUrl}/internal/admin/mrf/traces?limit=5`,
    { method: "GET", headers: authHeaders(token, "provider:read") },
  );
  assert(traces.status === 200, `trace list failed with status ${traces.status}`);
  assert(traces.body && "data" in traces.body, "trace list missing data");

  const traceItems = (traces.body as TraceListResponse).data;
  if (traceItems.length > 0) {
    const first = traceItems[0];
    assert(!("rawContent" in first), "trace redaction failed: rawContent present by default");
    assert(!("signedHeaders" in first), "trace redaction failed: signedHeaders present by default");
    assert(!("token" in first), "trace redaction failed: token present by default");
    assert(!("dmPayload" in first), "trace redaction failed: dmPayload present by default");
  }

  const simulationCreate = await requestJson<SimulationCreateResponse>(
    `${baseUrl}/internal/admin/mrf/simulations`,
    {
      method: "POST",
      headers: authHeaders(token, "provider:simulate"),
      body: JSON.stringify({
        payload: {
          id: `urn:smoke:${Date.now()}`,
          actor: "https://example.com/users/smoke",
          content: "smoke simulation",
          visibility: "public",
          tags: ["smoke"],
          language: "en",
        },
      }),
    },
  );

  assert(simulationCreate.status === 202, `simulation create failed with status ${simulationCreate.status}`);
  assert(simulationCreate.body && "data" in simulationCreate.body, "simulation create missing data");

  const jobId = (simulationCreate.body as SimulationCreateResponse).data.jobId;
  assert(typeof jobId === "string" && jobId.length > 0, "simulation jobId missing");

  const simulationResult = await backoffPoll(
    async () =>
      requestJson<SimulationGetResponse>(
        `${baseUrl}/internal/admin/mrf/simulations/${encodeURIComponent(jobId)}`,
        { method: "GET", headers: authHeaders(token, "provider:simulate") },
      ),
    {
      maxAttempts,
      baseMs,
      maxMs,
      shouldStop: (result) => {
        if (result.status !== 200) return true;
        const body = result.body as SimulationGetResponse | null;
        const status = body?.data?.status;
        return status === "completed" || status === "failed" || status === "cancelled";
      },
    },
  );

  assert(simulationResult.status === 200, `simulation poll failed with status ${simulationResult.status}`);
  const finalStatus = (simulationResult.body as SimulationGetResponse).data.status;
  assert(finalStatus === "completed", `expected completed simulation, got ${finalStatus}`);

  console.log("[smoke] mrf admin smoke checks passed");
}

main().catch((err) => {
  console.error("[smoke] failed", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
