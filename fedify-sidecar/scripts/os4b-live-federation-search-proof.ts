import { setTimeout as sleep } from "node:timers/promises";

const REMOTE = process.env["OS4B_REMOTE_CONTROL_URL"] ?? "http://127.0.0.1:18890";
const OPENSEARCH = process.env["OS4B_OPENSEARCH_URL"] ?? "http://127.0.0.1:19200";
const INDEX = process.env["OS4B_OPENSEARCH_INDEX"] ?? "public-content-v1";
const TIMEOUT_MS = Number.parseInt(process.env["OS4B_LIVE_TIMEOUT_MS"] ?? "60000", 10);

type Fixture = {
  token: string;
  objectId: string;
  initialContent: string;
  updatedContent: string;
  actorId: string;
};

type Hit = { _id: string; _source: Record<string, unknown> };

async function jsonFetch(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url} failed ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function send(stage: "create" | "update" | "delete"): Promise<Fixture & { status: number }> {
  return jsonFetch(`${REMOTE}/send/${stage}`, { method: "POST" });
}

async function searchToken(token: string): Promise<Hit[]> {
  const body = {
    size: 20,
    query: {
      bool: {
        must: [{ match_phrase: { text: token } }],
      },
    },
  };
  const result = await jsonFetch(`${OPENSEARCH}/${INDEX}/_search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return result?.hits?.hits ?? [];
}

async function waitFor(label: string, predicate: () => Promise<Hit | null>): Promise<{ hit: Hit; elapsedMs: number }> {
  const startedAt = Date.now();
  let last: unknown = null;
  while (Date.now() - startedAt < TIMEOUT_MS) {
    try {
      const hit = await predicate();
      if (hit) return { hit, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      last = error;
    }
    await sleep(250);
  }
  throw new Error(`${label} did not converge within ${TIMEOUT_MS} ms${last ? `: ${String(last)}` : ""}`);
}

function sourceText(hit: Hit): string {
  return typeof hit._source.text === "string" ? hit._source.text : "";
}

async function main() {
  await jsonFetch(`${REMOTE}/health`);
  await jsonFetch(`${OPENSEARCH}/_cluster/health`);
  const fixture = await jsonFetch(`${REMOTE}/fixture`) as Fixture;

  const createSentAt = Date.now();
  await send("create");
  const created = await waitFor("federated Create becoming searchable", async () => {
    const hits = await searchToken(fixture.token);
    return hits.find((hit) => sourceText(hit).includes("initial") && hit._source.isDeleted !== true) ?? null;
  });

  const updateSentAt = Date.now();
  await send("update");
  const updated = await waitFor("federated Update replacing searchable content", async () => {
    const hits = await searchToken(fixture.token);
    return hits.find((hit) => sourceText(hit).includes("updated") && !sourceText(hit).includes("initial") && hit._source.isDeleted !== true) ?? null;
  });

  const deleteSentAt = Date.now();
  await send("delete");
  const deleted = await waitFor("federated Delete producing a search tombstone", async () => {
    const hits = await searchToken(fixture.token);
    return hits.find((hit) => hit._source.isDeleted === true) ?? null;
  });

  const finalPublicSearch = await jsonFetch(`${OPENSEARCH}/${INDEX}/_search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      size: 10,
      query: {
        bool: {
          must: [{ match_phrase: { text: fixture.token } }],
          must_not: [{ term: { isDeleted: true } }],
        },
      },
    }),
  });
  const visibleAfterDelete = Number(finalPublicSearch?.hits?.total?.value ?? finalPublicSearch?.hits?.hits?.length ?? 0);
  if (visibleAfterDelete !== 0) throw new Error(`Deleted federated object remains publicly searchable (${visibleAfterDelete} hits)`);

  const result = {
    schema: "os4b.live-federation-search-proof.v1",
    ok: true,
    actorId: fixture.actorId,
    objectId: fixture.objectId,
    createToSearchMs: created.elapsedMs,
    updateToSearchMs: updated.elapsedMs,
    deleteToTombstoneMs: deleted.elapsedMs,
    createRoundTripMs: Date.now() - createSentAt,
    updateSentAt,
    deleteSentAt,
    stableDocumentId: created.hit._id,
    sameDocumentAcrossUpdate: created.hit._id === updated.hit._id,
    sameDocumentAcrossDelete: created.hit._id === deleted.hit._id,
    visibleAfterDelete,
  };
  if (!result.sameDocumentAcrossUpdate || !result.sameDocumentAcrossDelete) {
    throw new Error(`Federation lifecycle changed stable search document id: ${JSON.stringify(result)}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
