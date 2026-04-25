type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

const DEFAULT_BACKEND_BASE = "http://localhost:3000";
const DEFAULT_MEDIA_BASE = "http://localhost:8090";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_PROOF_TIMEOUT_MS = 90_000;
const DEFAULT_PASSWORD = "Test1test";
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0X8AAAAASUVORK5CYII=";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

async function readJson(response: Response): Promise<Json> {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as Json;
  } catch {
    return text;
  }
}

async function request(
  url: string,
  init?: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ response: Response; body: Json }> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });

  return {
    response,
    body: await readJson(response),
  };
}

function pickString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const picked = pickString(item);
      if (picked) return picked;
    }
  }

  if (value && typeof value === "object") {
    const candidate =
      pickString((value as Record<string, unknown>)["@id"])
      ?? pickString((value as Record<string, unknown>).id)
      ?? pickString((value as Record<string, unknown>).url);
    if (candidate) return candidate;
  }

  return undefined;
}

function pickStrings(value: unknown): string[] {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(item => pickStrings(item));
  }

  if (value && typeof value === "object") {
    return [
      ...pickStrings((value as Record<string, unknown>)["@id"]),
      ...pickStrings((value as Record<string, unknown>).id),
    ];
  }

  return [];
}

function pickNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function redact(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/token|authorization|password/i.test(key)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redact(entry);
    }
  }
  return output;
}

function buildProofUser() {
  const username = `media-proof-${Date.now()}`;
  return {
    username,
    email: `${username}@example.com`,
    password: DEFAULT_PASSWORD,
    name: "Media Proof User",
    "schema:knowsLanguage": "en",
  };
}

function buildBackoffDelayMs(attempt: number): number {
  const baseDelayMs = 500;
  const capDelayMs = 5_000;
  const exponentialDelayMs = Math.min(capDelayMs, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
  const jitterFactor = 0.5 + Math.random();
  return Math.max(100, Math.floor(exponentialDelayMs * jitterFactor));
}

function fallbackUploadsContainerUri(webId: string): string {
  const parsed = new URL(webId);
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return new URL(`${pathname}/data/semapps/file`, parsed.origin).toString();
}

function isFileTypeRegistration(value: unknown): boolean {
  return pickStrings(value).some(entry => {
    const normalized = entry.toLowerCase();
    return (
      normalized === "semapps:file"
      || normalized === "http://semapps.org/ns/core#file"
      || normalized === "https://semapps.org/ns/core#file"
      || normalized.endsWith("#file")
    );
  });
}

async function resolveUploadsContainerUri(
  webId: string,
  token: string,
): Promise<string> {
  const webIdDocument = await request(webId, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/ld+json",
    },
  });

  assert(
    webIdDocument.response.ok,
    `Fetching webId failed with status ${webIdDocument.response.status}: ${JSON.stringify(redact(webIdDocument.body))}`,
  );

  const actor = webIdDocument.body as Record<string, unknown>;
  const publicTypeIndexUrl = pickString(actor["solid:publicTypeIndex"]);
  if (!publicTypeIndexUrl) {
    return fallbackUploadsContainerUri(webId);
  }

  const typeIndexDocument = await request(publicTypeIndexUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/ld+json",
    },
  });

  assert(
    typeIndexDocument.response.ok,
    `Fetching type index failed with status ${typeIndexDocument.response.status}: ${JSON.stringify(redact(typeIndexDocument.body))}`,
  );

  const typeIndex = typeIndexDocument.body as Record<string, unknown>;
  const registrations = Array.isArray(typeIndex["solid:hasTypeRegistration"])
    ? typeIndex["solid:hasTypeRegistration"]
    : typeIndex["solid:hasTypeRegistration"]
      ? [typeIndex["solid:hasTypeRegistration"]]
      : [];

  for (const registrationRef of registrations) {
    const registration =
      registrationRef && typeof registrationRef === "object" && !Array.isArray(registrationRef)
        ? registrationRef as Record<string, unknown>
        : (() => {
            const id = pickString(registrationRef);
            return id ? { id } : null;
          })();

    if (!registration) continue;

    const expanded =
      registration["solid:forClass"] || registration["solid:instanceContainer"]
        ? registration
        : (() => {
            const registrationUrl = pickString(registration);
            return registrationUrl ? { id: registrationUrl } : null;
          })();

    let resolvedRegistration = expanded;
    if (
      resolvedRegistration
      && !resolvedRegistration["solid:forClass"]
      && !resolvedRegistration["solid:instanceContainer"]
    ) {
      const registrationUrl = pickString(resolvedRegistration);
      if (registrationUrl) {
        const registrationDocument = await request(registrationUrl, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/ld+json",
          },
        });
        if (registrationDocument.response.ok && registrationDocument.body && typeof registrationDocument.body === "object") {
          resolvedRegistration = registrationDocument.body as Record<string, unknown>;
        }
      }
    }

    if (!resolvedRegistration) continue;

    const instanceContainer = pickString(resolvedRegistration["solid:instanceContainer"]);
    if (!instanceContainer) continue;

    if (
      isFileTypeRegistration(resolvedRegistration["solid:forClass"])
      || instanceContainer.includes("/semapps/file")
    ) {
      return instanceContainer;
    }
  }

  return fallbackUploadsContainerUri(webId);
}

async function waitForContainerReadiness(
  containerUri: string,
  token: string,
  timeoutMs: number,
): Promise<{ attempts: number }> {
  let attempts = 0;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    const container = await request(containerUri, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/ld+json",
      },
    });

    if (container.response.ok) {
      return { attempts };
    }

    await sleep(buildBackoffDelayMs(attempts));
  }

  throw new Error(`Timed out waiting for upload container readiness at ${containerUri}`);
}

async function main(): Promise<void> {
  const backendBase = normalizeBaseUrl(process.env["MEDIA_PROOF_BACKEND_BASE"] || DEFAULT_BACKEND_BASE);
  const mediaBase = normalizeBaseUrl(process.env["MEDIA_PROOF_MEDIA_BASE"] || DEFAULT_MEDIA_BASE);
  const proofTimeoutMs = Number.parseInt(
    process.env["MEDIA_PROOF_TIMEOUT_MS"] || String(DEFAULT_PROOF_TIMEOUT_MS),
    10,
  );

  const user = buildProofUser();
  const report: Record<string, unknown> = {
    ok: false,
    backendBase,
    mediaBase,
    username: user.username,
    steps: {},
  };

  try {
    const signup = await request(`${backendBase}/auth/signup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(user),
    });

    report.steps = {
      ...(report.steps as Record<string, unknown>),
      signup: {
        status: signup.response.status,
        body: redact(signup.body),
      },
    };

    assert(
      signup.response.ok,
      `Signup failed with status ${signup.response.status}: ${JSON.stringify(redact(signup.body))}`,
    );

    const signupBody = signup.body as Record<string, unknown>;
    const token = pickString(signupBody.token);
    const webId = pickString(signupBody.webId);
    assert(token, "Signup response did not include an auth token");
    assert(webId, "Signup response did not include a webId");

    let uploadContainerUri: string | undefined;
    let resolutionAttempts = 0;
    const resolutionStart = Date.now();

    while (Date.now() - resolutionStart < proofTimeoutMs) {
      resolutionAttempts += 1;
      try {
        uploadContainerUri = await resolveUploadsContainerUri(webId, token);
        if (uploadContainerUri) break;
      } catch {
        // Allow the pod/type index provisioning to settle before failing.
      }
      await sleep(buildBackoffDelayMs(resolutionAttempts));
    }

    report.steps = {
      ...(report.steps as Record<string, unknown>),
      resolveUploadContainer: {
        attempts: resolutionAttempts,
        uploadContainerUri: uploadContainerUri || null,
      },
    };

    assert(uploadContainerUri, "Timed out resolving the pod uploads container");
    const containerReadiness = await waitForContainerReadiness(uploadContainerUri, token, proofTimeoutMs);
    report.steps = {
      ...(report.steps as Record<string, unknown>),
      waitForUploadContainer: {
        attempts: containerReadiness.attempts,
        uploadContainerUri,
      },
    };

    const uploadBytes = Buffer.from(PNG_1X1_BASE64, "base64");
    let upload:
      | { response: Response; body: Json }
      | undefined;
    let uploadAttempts = 0;
    const uploadStartedAt = Date.now();

    while (Date.now() - uploadStartedAt < proofTimeoutMs) {
      uploadAttempts += 1;
      upload = await request(uploadContainerUri, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "image/png",
          Accept: "application/ld+json",
        },
        body: uploadBytes,
      });

      if (upload.response.status === 201) {
        break;
      }

      if (upload.response.status !== 400 && upload.response.status !== 404) {
        break;
      }

      await sleep(buildBackoffDelayMs(uploadAttempts));
    }

    assert(upload, "Upload request did not produce a response");

    const fileResourceUrl =
      upload.response.headers.get("location")
      || pickString(upload.body && typeof upload.body === "object" ? (upload.body as Record<string, unknown>).id : null);

    report.steps = {
      ...(report.steps as Record<string, unknown>),
      upload: {
        attempts: uploadAttempts,
        status: upload.response.status,
        container: uploadContainerUri,
        body: redact(upload.body),
        location: fileResourceUrl || null,
      },
    };

    assert(
      upload.response.status === 201,
      `Upload failed with status ${upload.response.status}: ${JSON.stringify(redact(upload.body))}`,
    );
    assert(fileResourceUrl, "Upload response did not include a file resource location");

    const proofStart = Date.now();
    let finalResource: Record<string, unknown> | null = null;
    let mediaUrl: string | undefined;
    let attempts = 0;

    while (Date.now() - proofStart < proofTimeoutMs) {
      attempts += 1;

      const resource = await request(fileResourceUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/ld+json",
        },
      });

      assert(
        resource.response.ok,
        `Fetching uploaded file failed with status ${resource.response.status}: ${JSON.stringify(redact(resource.body))}`,
      );

      const candidate = resource.body as Record<string, unknown>;
      const candidateUrl = pickString(candidate.url);
      const candidateMediaType = pickString(candidate.mediaType);
      const candidateWidth = pickNumber(candidate.width);
      const candidateHeight = pickNumber(candidate.height);
      const candidateDigest = pickString(candidate.digestMultibase);

      if (
        candidateUrl
        && candidateUrl.startsWith(`${mediaBase}/media/`)
        && candidateMediaType === "image/webp"
        && typeof candidateWidth === "number"
        && candidateWidth > 0
        && typeof candidateHeight === "number"
        && candidateHeight > 0
        && candidateDigest
      ) {
        finalResource = candidate;
        mediaUrl = candidateUrl;
        break;
      }

      await sleep(buildBackoffDelayMs(attempts));
    }

    assert(finalResource, `Timed out waiting for media sync after ${attempts} attempts`);
    assert(mediaUrl, "Final resource did not contain a derived media URL");

    const mediaHead = await fetch(mediaUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    assert(mediaHead.ok, `Derived media URL returned HTTP ${mediaHead.status}`);

    const derivedContentType = (mediaHead.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    assert(
      derivedContentType === "image/webp",
      `Derived media URL returned unexpected content type: ${derivedContentType || "missing"}`,
    );

    report.ok = true;
    report.fileResourceUrl = fileResourceUrl;
    report.derivedMediaUrl = mediaUrl;
    report.width = pickNumber(finalResource.width);
    report.height = pickNumber(finalResource.height);
    report.size = pickNumber(finalResource.size);
    report.digestMultibase = pickString(finalResource.digestMultibase);
    report.webId = webId;
    report.attempts = attempts;
    report.processingMs = Date.now() - proofStart;
    report.steps = {
      ...(report.steps as Record<string, unknown>),
      finalResource: {
        url: pickString(finalResource.url) || null,
        mediaType: pickString(finalResource.mediaType) || null,
        width: pickNumber(finalResource.width) || null,
        height: pickNumber(finalResource.height) || null,
        size: pickNumber(finalResource.size) || null,
        digestMultibase: pickString(finalResource.digestMultibase) || null,
      },
      mediaHead: {
        status: mediaHead.status,
        contentType: derivedContentType,
        cacheControl: mediaHead.headers.get("cache-control"),
      },
    };

    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.ok = false;
    report.error = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }
}

main();
