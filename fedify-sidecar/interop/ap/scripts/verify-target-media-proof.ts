import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

type AttachmentProof = {
  fixtureUrl: string;
  fixtureType: string;
  mediaActivityId: string;
  mediaObjectId: string;
  contentMarker: string;
  publishedAt: string;
  dereferenceObserved: boolean;
  accessCount: number;
  methods: string[];
  firstReceivedAt?: number;
  userAgents: string[];
};

type ProofResult = {
  ok: boolean;
  target: string;
  attachmentProof?: AttachmentProof;
};

type VerificationRow = {
  statusId: string;
  statusUri: string;
  statusUrl: string;
  statusText: string;
  statusContent: string;
  attachmentCount: number;
  remoteUrl: string;
  fileContentType: string;
  createdAt: string;
};

const TARGET = process.env["AP_INTEROP_TARGET"] || "";
const RESULT_FILE = process.env["AP_INTEROP_PROOF_RESULT_FILE"] || "";
const COMPOSE_FILE = process.env["AP_INTEROP_COMPOSE_FILE"] || "";
const VERIFY_TIMEOUT_MS = Number.parseInt(
  process.env["AP_INTEROP_VERIFY_TIMEOUT_MS"] || "120000",
  10,
);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FEDIFY_SIDECAR_ROOT = resolve(SCRIPT_DIR, "../../..");
const GOTOSOCIAL_DB_FILE =
  process.env["AP_INTEROP_GOTOSOCIAL_DB_FILE"]
  || resolve(FEDIFY_SIDECAR_ROOT, "interop/ap/runtime/gotosocial/sqlite.db");

async function main(): Promise<void> {
  if (TARGET.length === 0) {
    throw new Error("AP_INTEROP_TARGET is required");
  }
  if (RESULT_FILE.length === 0) {
    throw new Error("AP_INTEROP_PROOF_RESULT_FILE is required");
  }

  const proof = JSON.parse(await readFile(resolvePath(RESULT_FILE), "utf8")) as ProofResult;
  if (!proof.ok || proof.attachmentProof == null) {
    throw new Error(`Proof result did not include attachment metadata: ${RESULT_FILE}`);
  }

  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  const row = await waitForVerification(proof.attachmentProof, deadline);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target: TARGET,
        statusId: row.statusId,
        statusUri: row.statusUri,
        statusUrl: row.statusUrl,
        attachmentCount: row.attachmentCount,
        remoteUrl: row.remoteUrl,
        fileContentType: row.fileContentType,
        dereferenceObserved: proof.attachmentProof.dereferenceObserved,
        fixtureAccessCount: proof.attachmentProof.accessCount,
      },
      null,
      2,
    ),
  );
}

async function waitForVerification(
  proof: AttachmentProof,
  deadline: number,
): Promise<VerificationRow> {
  let attempt = 0;
  let lastRow: VerificationRow | null = null;
  let lastError: string | null = null;

  while (Date.now() < deadline) {
    try {
      const row = await queryVerificationRow(proof);
      if (row && row.attachmentCount > 0) {
        return row;
      }
      lastRow = row;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(computeBackoffDelay(attempt++));
  }

  const details = lastRow
    ? `last row: ${JSON.stringify(lastRow)}`
    : lastError
      ? `last error: ${lastError}`
      : "no matching remote status observed";
  throw new Error(`Timed out verifying target media proof for ${TARGET}; ${details}`);
}

async function queryVerificationRow(proof: AttachmentProof): Promise<VerificationRow | null> {
  switch (TARGET) {
    case "gotosocial":
      return querySqliteProof(GOTOSOCIAL_DB_FILE, proof);
    case "mastodon":
      return queryPostgresProof("mastodon-db", "mastodon_production", buildMastodonSql(proof));
    case "akkoma":
      return queryPostgresProof("akkoma-db", "akkoma", buildAkkomaSql(proof));
    default:
      throw new Error(`Unsupported AP interop target '${TARGET}'`);
  }
}

async function querySqliteProof(
  dbFile: string,
  proof: AttachmentProof,
): Promise<VerificationRow | null> {
  const { stdout } = await runCommand("sqlite3", [
    "-cmd",
    ".timeout 5000",
    "-tabs",
    "-noheader",
    `file:${resolvePath(dbFile)}?mode=ro`,
    buildGotoSocialSql(proof),
  ]);
  return parseVerificationRow(stdout);
}

async function queryPostgresProof(
  service: string,
  database: string,
  sql: string,
): Promise<VerificationRow | null> {
  if (COMPOSE_FILE.length === 0) {
    throw new Error("AP_INTEROP_COMPOSE_FILE is required for PostgreSQL-backed targets");
  }

  const command =
    `docker compose -f ${shellQuote(resolvePath(COMPOSE_FILE))}`
    + ` exec -T ${shellQuote(service)}`
    + ` env PGPASSWORD=postgres psql -U postgres -d ${shellQuote(database)}`
    + ` -At -F "$(printf '\\t')" -c ${shellQuote(sql)}`;
  const { stdout } = await runShellCommand(command);
  return parseVerificationRow(stdout);
}

// GoToSocial: SQLite, statuses table has s.content (HTML rendered body)
function buildGotoSocialSql(proof: AttachmentProof): string {
  const activityId = sqlLiteral(proof.mediaActivityId);
  const objectId = sqlLiteral(proof.mediaObjectId);
  const marker = likeLiteral(proof.contentMarker);
  const fixtureUrl = sqlLiteral(proof.fixtureUrl);

  return `
    SELECT
      s.id,
      COALESCE(s.uri, ''),
      COALESCE(s.url, ''),
      COALESCE(s.text, ''),
      COALESCE(s.content, ''),
      COUNT(ma.id),
      COALESCE(MAX(ma.remote_url), ''),
      COALESCE(MAX(ma.file_content_type), ''),
      COALESCE(CAST(s.created_at AS TEXT), '')
    FROM statuses s
    LEFT JOIN media_attachments ma ON ma.status_id = s.id
    WHERE COALESCE(s.uri, '') IN (${activityId}, ${objectId})
       OR COALESCE(s.url, '') IN (${activityId}, ${objectId})
       OR COALESCE(s.text, '') LIKE ${marker}
       OR COALESCE(s.content, '') LIKE ${marker}
       OR COALESCE(ma.remote_url, '') = ${fixtureUrl}
    GROUP BY s.id, s.uri, s.url, s.text, s.content, s.created_at
    ORDER BY s.created_at DESC
    LIMIT 1;
  `;
}

// Mastodon: PostgreSQL, statuses table has s.text but no s.content column
function buildMastodonSql(proof: AttachmentProof): string {
  const activityId = sqlLiteral(proof.mediaActivityId);
  const objectId = sqlLiteral(proof.mediaObjectId);
  const marker = likeLiteral(proof.contentMarker);
  const fixtureUrl = sqlLiteral(proof.fixtureUrl);

  return `
    SELECT
      s.id,
      COALESCE(s.uri, ''),
      COALESCE(s.url, ''),
      COALESCE(s.text, ''),
      COALESCE(s.spoiler_text, ''),
      COUNT(ma.id),
      COALESCE(MAX(ma.remote_url), ''),
      COALESCE(MAX(ma.file_content_type), ''),
      COALESCE(CAST(s.created_at AS TEXT), '')
    FROM statuses s
    LEFT JOIN media_attachments ma ON ma.status_id = s.id
    WHERE COALESCE(s.uri, '') IN (${activityId}, ${objectId})
       OR COALESCE(s.url, '') IN (${activityId}, ${objectId})
       OR COALESCE(s.text, '') LIKE ${marker}
       OR COALESCE(s.spoiler_text, '') LIKE ${marker}
       OR COALESCE(ma.remote_url, '') = ${fixtureUrl}
    GROUP BY s.id, s.uri, s.url, s.text, s.spoiler_text, s.created_at
    ORDER BY s.created_at DESC
    LIMIT 1;
  `;
}

// Akkoma: PostgreSQL, stores ActivityPub objects in an objects JSONB table
function buildAkkomaSql(proof: AttachmentProof): string {
  const activityId = sqlLiteral(proof.mediaActivityId);
  const objectId = sqlLiteral(proof.mediaObjectId);
  const marker = likeLiteral(proof.contentMarker);
  const fixtureUrl = sqlLiteral(proof.fixtureUrl);

  return `
    WITH matching_objects AS (
      SELECT
        o.id,
        COALESCE(o.data->>'id', '') AS object_uri,
        COALESCE(o.data->>'url', '') AS object_url,
        COALESCE(o.data->>'content', '') AS object_content,
        COALESCE(jsonb_array_length(COALESCE(o.data->'attachment', '[]'::jsonb)), 0) AS attachment_count,
        COALESCE(
          MAX(
            CASE
              WHEN jsonb_typeof(att.value->'url') = 'array' THEN att.value->'url'->0->>'href'
              WHEN jsonb_typeof(att.value->'url') = 'object' THEN att.value->'url'->>'href'
              ELSE NULL
            END
          ),
          ''
        ) AS remote_url,
        COALESCE(
          MAX(
            COALESCE(
              CASE
                WHEN jsonb_typeof(att.value->'url') = 'array' THEN att.value->'url'->0->>'mediaType'
                WHEN jsonb_typeof(att.value->'url') = 'object' THEN att.value->'url'->>'mediaType'
                ELSE NULL
              END,
              att.value->>'mediaType'
            )
          ),
          ''
        ) AS file_content_type,
        COALESCE(CAST(o.inserted_at AS TEXT), '') AS created_at
      FROM objects o
      LEFT JOIN LATERAL jsonb_array_elements(COALESCE(o.data->'attachment', '[]'::jsonb)) AS att(value) ON TRUE
      WHERE COALESCE(o.data->>'id', '') IN (${activityId}, ${objectId})
         OR COALESCE(o.data->>'url', '') IN (${activityId}, ${objectId})
         OR COALESCE(o.data->>'content', '') LIKE ${marker}
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements(COALESCE(o.data->'attachment', '[]'::jsonb)) AS attachment(value)
           WHERE CASE
             WHEN jsonb_typeof(attachment.value->'url') = 'array' THEN attachment.value->'url'->0->>'href'
             WHEN jsonb_typeof(attachment.value->'url') = 'object' THEN attachment.value->'url'->>'href'
             ELSE ''
           END = ${fixtureUrl}
         )
      GROUP BY o.id, o.data, o.inserted_at
    )
    SELECT
      id,
      object_uri,
      object_url,
      object_content,
      object_content,
      attachment_count,
      remote_url,
      file_content_type,
      created_at
    FROM matching_objects
    ORDER BY created_at DESC
    LIMIT 1;
  `;
}

function parseVerificationRow(stdout: string): VerificationRow | null {
  const line = stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trimEnd())
    .find((entry) => entry.length > 0);
  if (!line) {
    return null;
  }

  const [
    statusId,
    statusUri,
    statusUrl,
    statusText,
    statusContent,
    attachmentCountRaw,
    remoteUrl,
    fileContentType,
    createdAt,
  ] = line.split("\t");

  return {
    statusId: statusId ?? "",
    statusUri: statusUri ?? "",
    statusUrl: statusUrl ?? "",
    statusText: statusText ?? "",
    statusContent: statusContent ?? "",
    attachmentCount: Number.parseInt(attachmentCountRaw ?? "0", 10) || 0,
    remoteUrl: remoteUrl ?? "",
    fileContentType: fileContentType ?? "",
    createdAt: createdAt ?? "",
  };
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function likeLiteral(value: string): string {
  return `'${`%${value}%`.replaceAll("'", "''")}'`;
}

function computeBackoffDelay(attempt: number): number {
  const exponential = Math.min(500 * Math.pow(2, attempt), 5_000);
  const jitter = Math.floor(Math.random() * Math.max(250, Math.floor(exponential / 5)));
  return exponential + jitter;
}

function resolvePath(pathValue: string): string {
  if (isAbsolute(pathValue)) {
    return pathValue;
  }

  return resolve(FEDIFY_SIDECAR_ROOT, pathValue);
}

async function runCommand(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} exited with ${code}: ${stderr.trim() || stdout.trim()}`,
        ),
      );
    });
  });
}

async function runShellCommand(command: string): Promise<{ stdout: string; stderr: string }> {
  return runCommand("/bin/sh", ["-lc", command]);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

main().catch((error) => {
  console.error(
    "[verify-target-media-proof] failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
