// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
  brokerAssertionRequestSchema,
  providerAudience,
  type BrokerAssertionRequest,
} from "@repo/workload-identity/broker";

const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`;
const CLOCK_SKEW_SECONDS = 30;
const MAX_REQUEST_BYTES = 32_768;
const MAX_JTI_LENGTH = 200;
/** Upstream JWKS fetches never outlive this; a stalled GitHub must fail the mint, not hang it. */
const GITHUB_JWKS_TIMEOUT_MS = 5_000;
/**
 * A verified-signature miss on the kid memo refetches GitHub's JWKS at most this often. An
 * attacker sending unknown `kid`s otherwise turns every unauthenticated request into an upstream
 * fetch, which is the amplification the memo exists to remove.
 */
const GITHUB_JWKS_REFETCH_INTERVAL_MS = 60_000;
/** Only this alphabet, and no padding, is a compact-JWT segment; anything else is refused. */
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

interface JsonWebKeyWithKid extends JsonWebKey {
  kid: string;
}

interface SigningKeySet {
  activeKid: string;
  keys: JsonWebKeyWithKid[];
}

/** An opaque Durable Object id; only its identity is used. */
interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

/** The subset of Cloudflare's Durable Object namespace the Worker uses. */
export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

/** The subset of Durable Object storage the replay guard uses. */
export interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(timestamp: number): Promise<void>;
  deleteAll(): Promise<void>;
}

/** The subset of Durable Object state the replay guard uses. */
export interface DurableObjectState {
  storage: DurableObjectStorage;
}

export interface Env {
  REPLAY_GUARD: DurableObjectNamespace;
  ISSUER_URL: string;
  GITHUB_TOKEN_AUDIENCE: string;
  ALLOWED_REPOSITORIES: string;
  ALLOWED_WORKFLOW_REFS: string;
  SIGNING_KEYS_JSON: string;
}

interface JwtParts {
  header: { [key: string]: unknown };
  payload: { [key: string]: unknown };
  signingInput: Uint8Array;
  signature: Uint8Array;
}

interface GithubKeyCache {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

/**
 * Verified GitHub public keys by `kid`, memoised for the isolate's lifetime. GitHub rotates keys
 * rarely and publishes the incoming one ahead of use, so a miss is either a rotation (refetch) or
 * an attacker's guess (bounded by the refetch interval).
 */
const githubKeyCache: GithubKeyCache = { keys: new Map(), fetchedAt: 0 };

/**
 * Forgets every memoised GitHub key. Exists so a test can exercise the fetch path (timeouts,
 * heterogeneous JWKS documents) against a fresh isolate; production never calls it.
 */
export function clearGithubKeyCache(): void {
  githubKeyCache.keys.clear();
  githubKeyCache.fetchedAt = 0;
}

/**
 * Atomically consumes one GitHub token identifier until its expiry.
 *
 * Durable Object input gates already serialise the `get` → `put` pair below — a second request on
 * the same object cannot interleave between them — so there is no `blockConcurrencyWhile`. That
 * primitive's documented behaviour on a throw is to terminate and RESET the object, which turned a
 * transient storage error into a fresh, un-consumed guard instead of the 503 it should have been.
 */
export class ReplayGuard {
  constructor(private readonly state: DurableObjectState) {}

  /** Records the first use and refuses every subsequent use of this object id. */
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return new Response("method not allowed", { status: 405 });
    const body: unknown = await request.json();
    if (!isObject(body)) return new Response("invalid expiry", { status: 400 });
    const expiresAt = body.expiresAt;
    if (
      typeof expiresAt !== "number" ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now()
    ) {
      return new Response("invalid expiry", { status: 400 });
    }
    if (await this.state.storage.get<boolean>("consumed")) {
      return new Response("replayed", { status: 409 });
    }
    await this.state.storage.put("consumed", true);
    await this.state.storage.setAlarm(expiresAt);
    return new Response(null, { status: 204 });
  }

  /** Deletes expired replay state when Cloudflare fires the object alarm. */
  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}

/** Handles discovery, JWKS publication, and authenticated assertion minting. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let issuer: string;
    try {
      issuer = normalizedIssuer(env.ISSUER_URL);
    } catch {
      logOutcome({ outcome: "issuer_misconfigured" });
      return json({ error: "issuer_misconfigured" }, 500);
    }
    // ISSUER_URL is what every minted `iss` and the discovery document claim; if the Worker is
    // reached at any other origin the clouds would fetch `<iss>/.well-known/...` from somewhere
    // else, or see issuer != fetched URL, and reject silently. Refusing here makes the mismatch a
    // deploy-time failure (the workflow probes discovery after deploying) instead of a cloud-side one.
    if (url.origin !== issuer) {
      logOutcome({ outcome: "issuer_origin_mismatch" });
      return json({ error: "issuer_origin_mismatch" }, 503);
    }
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/openid-configuration"
    ) {
      return json({
        issuer,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        response_types_supported: ["id_token"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (request.method === "GET" && url.pathname === "/.well-known/jwks.json") {
      return publishJwks(env.SIGNING_KEYS_JSON);
    }
    if (request.method !== "POST" || url.pathname !== "/v1/assertions") {
      return json({ error: "not_found" }, 404);
    }
    return mintAssertion(request, env, issuer);
  },
};

/**
 * Publishes every public key in the bundle, independently of whether the PRIVATE half is usable.
 *
 * The signing path and the publishing path parse the same secret with different strictness on
 * purpose: a rotation step that stages a key without `d`, or retains a prior public key without
 * `alg`/`use`, must not take the public endpoint down — that is exactly the outage the two-step
 * rotation exists to avoid. And a mis-pasted secret is never allowed to reach a log: V8's
 * SyntaxError message quotes the characters around the failure, which here would be key material.
 */
function publishJwks(bundle: string): Response {
  let keys: JsonWebKeyWithKid[];
  try {
    keys = publishableKeys(bundle);
  } catch {
    logOutcome({ outcome: "jwks_unavailable" });
    return json({ error: "jwks_unavailable" }, 500);
  }
  return json({ keys: keys.map(publicJwk) }, 200, "public, max-age=300");
}

/** Authenticates one run-bound request and returns a short-lived broker assertion. */
async function mintAssertion(
  request: Request,
  env: Env,
  issuer: string,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  let runId = "unknown";
  let provider = "unknown";
  try {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > MAX_REQUEST_BYTES) {
      throw new HttpError(413, "request_too_large");
    }
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer "))
      throw new HttpError(401, "missing_bearer_token");
    const requestText = await request.text();
    if (new TextEncoder().encode(requestText).byteLength > MAX_REQUEST_BYTES) {
      throw new HttpError(413, "request_too_large");
    }
    let requestJson: unknown;
    try {
      requestJson = JSON.parse(requestText);
    } catch {
      throw new HttpError(400, "invalid_request");
    }
    const parsedBody = brokerAssertionRequestSchema.safeParse(requestJson);
    if (!parsedBody.success) throw new HttpError(400, "invalid_request");
    const body = parsedBody.data;
    runId = body.run.runId;
    provider = body.provider;

    // Authenticate BEFORE any policy decision. Policy refusals carry distinct codes so an operator
    // can read which allowlist a real run tripped; handed to an unauthenticated caller those codes
    // are an oracle for the allowlists themselves.
    const githubToken = authorization.slice("Bearer ".length);
    const githubClaims = await verifyGithubToken(
      githubToken,
      env.GITHUB_TOKEN_AUDIENCE,
    );
    assertAllowedRequest(body, env);
    assertRunBinding(githubClaims, body);
    await consumeReplay(githubClaims, env.REPLAY_GUARD);

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + body.ttlSeconds;
    const assertion = await signJwt(
      {
        iss: issuer,
        sub: body.subject,
        aud: body.audience,
        iat: now,
        nbf: now - CLOCK_SKEW_SECONDS,
        exp: expiresAt,
        jti: crypto.randomUUID(),
        repository: body.run.repository,
        workflow_ref: body.run.workflowRef,
        run_id: body.run.runId,
        run_attempt: body.run.runAttempt,
        provider: body.provider,
      },
      signingKeys(env.SIGNING_KEYS_JSON),
    );
    logOutcome({ requestId, runId, provider, outcome: "minted" });
    return json({
      assertion,
      issuer,
      audience: body.audience,
      subject: body.subject,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      run: body.run,
    });
  } catch (error: unknown) {
    const failure =
      error instanceof HttpError ? error : new HttpError(500, "internal_error");
    logOutcome({ requestId, runId, provider, outcome: failure.code });
    return json({ error: failure.code, requestId }, failure.status);
  }
}

/**
 * Refuses repositories, workflows, or cloud audiences outside the deployment policy.
 *
 * The audience is not an allowlist the deployment types in: it is the one audience the
 * provider's federation trust pins, from `@repo/workload-identity`, the same source the console
 * forwards as `request.audience`. Defence in depth against a console that asks for the wrong
 * audience, without a second copy that can drift from the first.
 */
function assertAllowedRequest(body: BrokerAssertionRequest, env: Env): void {
  if (!csvSet(env.ALLOWED_REPOSITORIES).has(body.run.repository)) {
    throw new HttpError(403, "repository_not_allowed");
  }
  if (!csvSet(env.ALLOWED_WORKFLOW_REFS).has(body.run.workflowRef)) {
    throw new HttpError(403, "workflow_not_allowed");
  }
  if (body.audience !== providerAudience(body.provider)) {
    throw new HttpError(403, "audience_not_allowed");
  }
}

/** Verifies GitHub's signature and the standard temporal and audience claims. */
async function verifyGithubToken(
  token: string,
  audience: string,
): Promise<{ [key: string]: unknown }> {
  const parts = parseJwt(token);
  if (parts.header.alg !== "RS256" || typeof parts.header.kid !== "string") {
    throw new HttpError(401, "invalid_github_token");
  }
  const key = await githubVerificationKey(parts.header.kid);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    arrayBuffer(parts.signature),
    arrayBuffer(parts.signingInput),
  );
  if (!valid) throw new HttpError(401, "invalid_github_token");
  validateStandardClaims(parts.payload, audience);
  return parts.payload;
}

/** Returns GitHub's public key for `kid`, refetching the JWKS on a miss at a bounded rate. */
async function githubVerificationKey(kid: string): Promise<CryptoKey> {
  const cached = githubKeyCache.keys.get(kid);
  if (cached) return cached;
  if (Date.now() - githubKeyCache.fetchedAt < GITHUB_JWKS_REFETCH_INTERVAL_MS) {
    throw new HttpError(401, "invalid_github_token");
  }
  await refreshGithubKeys();
  const key = githubKeyCache.keys.get(kid);
  if (!key) throw new HttpError(401, "invalid_github_token");
  return key;
}

/**
 * Replaces the memo with every usable RSA key GitHub currently publishes.
 *
 * RFC 7517 lets a JWKS carry keys of any type and keys without a `kid`, and GitHub has shipped
 * heterogeneous entries before; one unusable entry must not make the whole document invalid.
 */
async function refreshGithubKeys(): Promise<void> {
  let response: Response;
  try {
    response = await fetch(GITHUB_JWKS_URL, {
      signal: AbortSignal.timeout(GITHUB_JWKS_TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(503, "github_jwks_unavailable");
  }
  if (!response.ok) throw new HttpError(503, "github_jwks_unavailable");
  const document: unknown = await response.json();
  if (!isObject(document) || !Array.isArray(document.keys)) {
    throw new HttpError(503, "github_jwks_invalid");
  }
  const usable = document.keys.filter(isPublicJwk);
  if (usable.length === 0) throw new HttpError(503, "github_jwks_invalid");
  const keys = new Map<string, CryptoKey>();
  for (const jwk of usable) {
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e },
        rsaImportAlgorithm(),
        false,
        ["verify"],
      ),
    );
  }
  githubKeyCache.keys = keys;
  githubKeyCache.fetchedAt = Date.now();
}

/** Cross-checks request metadata against authenticated GitHub OIDC claims. */
function assertRunBinding(
  claims: { [key: string]: unknown },
  body: BrokerAssertionRequest,
): void {
  if (
    claims.repository !== body.run.repository ||
    claims.workflow_ref !== body.run.workflowRef ||
    claims.run_id !== body.run.runId ||
    Number(claims.run_attempt) !== body.run.runAttempt
  ) {
    throw new HttpError(403, "run_binding_mismatch");
  }
}

/**
 * Atomically consumes the verified token's `jti` until the token expires.
 *
 * Keyed on the claim, not on a digest of the bearer string: two encodings of one token (padding,
 * the standard alphabet) verify identically but digest differently, which made a captured token
 * redeemable once per spelling. `jti` is signed, so it names the token whatever its spelling.
 */
async function consumeReplay(
  claims: { [key: string]: unknown },
  namespace: DurableObjectNamespace,
): Promise<void> {
  const { exp, jti } = claims;
  if (typeof exp !== "number") throw new HttpError(401, "invalid_github_token");
  if (
    typeof jti !== "string" ||
    jti.length === 0 ||
    jti.length > MAX_JTI_LENGTH
  ) {
    throw new HttpError(401, "invalid_github_token");
  }
  // The token is inside its skew window but the guard has nothing left to hold: the same
  // refusal as any other expired token, not a guard outage.
  const expiresAt = (exp + CLOCK_SKEW_SECONDS) * 1000;
  if (expiresAt <= Date.now()) throw new HttpError(401, "invalid_github_token");
  const response = await namespace
    .get(namespace.idFromName(`${GITHUB_ISSUER}#${jti}`))
    .fetch(
      new Request("https://replay.internal/consume", {
        method: "POST",
        body: JSON.stringify({ expiresAt }),
      }),
    );
  if (response.status === 409)
    throw new HttpError(409, "github_token_replayed");
  if (response.status === 400) throw new HttpError(401, "invalid_github_token");
  if (!response.ok) throw new HttpError(503, "replay_guard_unavailable");
}

/** Signs a compact RS256 JWT with the configured active key. */
async function signJwt(
  payload: { [key: string]: unknown },
  keySet: SigningKeySet,
): Promise<string> {
  const jwk = keySet.keys.find(
    (candidate) => candidate.kid === keySet.activeKid,
  );
  if (!jwk || !jwk.d) throw new HttpError(500, "signing_key_unavailable");
  const header = base64Url(
    new TextEncoder().encode(
      JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid }),
    ),
  );
  const encodedPayload = base64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signingInput = new TextEncoder().encode(`${header}.${encodedPayload}`);
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    rsaImportAlgorithm(),
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    signingInput,
  );
  return `${header}.${encodedPayload}.${base64Url(new Uint8Array(signature))}`;
}

/** Validates issuer, audience, and bounded GitHub token timestamps. */
function validateStandardClaims(
  claims: { [key: string]: unknown },
  audience: string,
): void {
  const now = Math.floor(Date.now() / 1000);
  if (
    claims.iss !== GITHUB_ISSUER ||
    claims.aud !== audience ||
    typeof claims.exp !== "number" ||
    claims.exp < now - CLOCK_SKEW_SECONDS ||
    (typeof claims.nbf === "number" && claims.nbf > now + CLOCK_SKEW_SECONDS)
  ) {
    throw new HttpError(401, "invalid_github_token");
  }
}

/** Parses a compact JWT without trusting either decoded object. */
function parseJwt(token: string): JwtParts {
  const segments = token.split(".");
  if (segments.length !== 3) throw new HttpError(401, "invalid_github_token");
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new HttpError(401, "invalid_github_token");
  }
  let header: unknown;
  let payload: unknown;
  let signature: Uint8Array;
  try {
    header = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(encodedHeader)),
    );
    payload = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(encodedPayload)),
    );
    signature = decodeBase64Url(encodedSignature);
  } catch {
    throw new HttpError(401, "invalid_github_token");
  }
  if (!isObject(header) || !isObject(payload)) {
    throw new HttpError(401, "invalid_github_token");
  }
  return {
    header,
    payload,
    signingInput: new TextEncoder().encode(
      `${encodedHeader}.${encodedPayload}`,
    ),
    signature,
  };
}

/** Parses the bundle strictly enough to SIGN with it: every key complete, the active one private. */
function signingKeys(bundle: string): SigningKeySet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bundle);
  } catch {
    throw new HttpError(500, "signing_keys_invalid");
  }
  if (
    !isObject(parsed) ||
    typeof parsed.activeKid !== "string" ||
    !Array.isArray(parsed.keys)
  ) {
    throw new HttpError(500, "signing_keys_invalid");
  }
  const keys = parsed.keys.filter(isSigningJwk);
  if (
    keys.length !== parsed.keys.length ||
    !keys.some((key) => key.kid === parsed.activeKid && key.d)
  ) {
    throw new HttpError(500, "signing_keys_invalid");
  }
  return { activeKid: parsed.activeKid, keys };
}

/** Parses the bundle leniently enough to PUBLISH it: every entry with a public RSA half. */
function publishableKeys(bundle: string): JsonWebKeyWithKid[] {
  const parsed: unknown = JSON.parse(bundle);
  if (!isObject(parsed) || !Array.isArray(parsed.keys)) {
    throw new Error("invalid signing key set");
  }
  const keys = parsed.keys.filter(isPublicJwk);
  if (keys.length === 0) throw new Error("no publishable key");
  return keys;
}

/** Removes private RSA parameters before a key is published. */
function publicJwk(key: JsonWebKeyWithKid): JsonWebKeyWithKid {
  return {
    kty: key.kty,
    n: key.n,
    e: key.e,
    alg: "RS256",
    use: "sig",
    kid: key.kid,
  };
}

/** Returns the Web Crypto parameters shared by RSA imports. */
function rsaImportAlgorithm(): RsaHashedImportParams {
  return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
}

/** Produces a JSON response with explicit no-sniff and cache controls. */
function json(
  body: unknown,
  status = 200,
  cacheControl = "no-store",
): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": cacheControl,
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Normalizes the configured public issuer to one stable origin. */
function normalizedIssuer(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname !== "/")
    throw new Error("ISSUER_URL must be an HTTPS origin");
  return url.origin;
}

/** Converts a comma-separated allowlist to exact string members. */
function csvSet(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

/** Encodes bytes using the unpadded URL-safe Base64 alphabet. */
function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * Decodes one compact-JWT segment, refusing every spelling but the canonical one.
 *
 * `atob` tolerates padding, the standard alphabet and non-zero trailing bits, so several strings
 * decode to the same bytes and verify identically. Requiring the alphabet AND that re-encoding
 * reproduces the input leaves exactly one string per byte sequence.
 */
function decodeBase64Url(value: string): Uint8Array {
  if (!BASE64URL_SEGMENT.test(value)) throw new Error("non-canonical segment");
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (character) =>
    character.charCodeAt(0),
  );
  if (base64Url(bytes) !== value) throw new Error("non-canonical segment");
  return bytes;
}

/** Copies bytes into an ArrayBuffer accepted consistently by Web Crypto runtimes. */
function arrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

/** Narrows unknown JSON to a non-null object. */
function isObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null;
}

/** Narrows a value to the RSA public fields used for verification. */
function isPublicJwk(value: unknown): value is JsonWebKeyWithKid {
  return (
    isObject(value) &&
    value.kty === "RSA" &&
    typeof value.kid === "string" &&
    typeof value.n === "string" &&
    typeof value.e === "string"
  );
}

/** Narrows a value to a configured RSA signing key. */
function isSigningJwk(value: unknown): value is JsonWebKeyWithKid {
  return isPublicJwk(value) && value.alg === "RS256" && value.use === "sig";
}

/** Emits only non-secret identifiers and the request outcome. */
function logOutcome(event: {
  requestId?: string;
  runId?: string;
  provider?: string;
  outcome: string;
}): void {
  console.log(JSON.stringify(event));
}

class HttpError extends Error {
  /** Creates an HTTP-safe refusal without retaining sensitive request data. */
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
