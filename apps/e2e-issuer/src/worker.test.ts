// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import worker, {
  clearGithubKeyCache,
  ReplayGuard,
  type DurableObjectState,
  type DurableObjectStorage,
  type Env,
} from "./worker";

const issuer = "https://issuer.example.test";
const workflowRef =
  "alethialabs-io/alethialabs/.github/workflows/e2e-nightly.yml@refs/heads/dev";
const githubAudience = "alethia-e2e-broker";
const requestBody = {
  provider: "aws",
  audience: "sts.amazonaws.com",
  run: {
    repository: "alethialabs-io/alethialabs",
    workflowRef,
    runId: "123456",
    runAttempt: 2,
  },
};

interface TestJwk extends JsonWebKey {
  kid: string;
}

let githubPrivateKey: CryptoKey;
let githubPublicJwk: JsonWebKey;
let brokerPrivateJwk: JsonWebKey;
let oldBrokerPrivateJwk: JsonWebKey;

beforeAll(async () => {
  const githubKeys = await generateRsaKeyPair();
  githubPrivateKey = githubKeys.privateKey;
  githubPublicJwk = await crypto.subtle.exportKey("jwk", githubKeys.publicKey);
  const brokerKeys = await generateRsaKeyPair();
  brokerPrivateJwk = await crypto.subtle.exportKey(
    "jwk",
    brokerKeys.privateKey,
  );
  const oldBrokerKeys = await generateRsaKeyPair();
  oldBrokerPrivateJwk = await crypto.subtle.exportKey(
    "jwk",
    oldBrokerKeys.privateKey,
  );
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearGithubKeyCache();
});

describe("E2E assertion issuer", () => {
  it("publishes OIDC discovery and every rotation key without private material", async () => {
    const env = testEnv();
    const discovery = await worker.fetch(
      new Request(`${issuer}/.well-known/openid-configuration`),
      env,
    );
    expect(await discovery.json()).toEqual({
      issuer,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
    });

    const response = await worker.fetch(
      new Request(`${issuer}/.well-known/jwks.json`),
      env,
    );
    const document = await response.json();
    expect(document).toMatchObject({
      keys: [
        { kid: "active", alg: "RS256", use: "sig" },
        { kid: "previous", alg: "RS256", use: "sig" },
      ],
    });
    expect(JSON.stringify(document)).not.toContain('"d"');
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("refuses to serve at any origin other than the configured issuer", async () => {
    const response = await worker.fetch(
      new Request(
        "https://other.example.test/.well-known/openid-configuration",
      ),
      testEnv(),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "issuer_origin_mismatch",
    });
  });

  it("keeps the public keys published when the private half is unusable, and never logs the bundle", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const staged = testEnv();
    staged.SIGNING_KEYS_JSON = JSON.stringify({
      activeKid: "staged",
      keys: [
        { ...publicHalf(brokerPrivateJwk), kid: "staged" },
        { ...publicHalf(oldBrokerPrivateJwk), kid: "previous" },
      ],
    });
    const published = await worker.fetch(
      new Request(`${issuer}/.well-known/jwks.json`),
      staged,
    );
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({
      keys: [{ kid: "staged" }, { kid: "previous" }],
    });

    mockGithubJwks();
    const minted = await mint(staged, await githubToken(), requestBody);
    expect(minted.status).toBe(500);
    expect(await minted.json()).toMatchObject({
      error: "signing_keys_invalid",
    });

    const secretFragment = "SECRETSECRETSECRET";
    const pasted = testEnv();
    pasted.SIGNING_KEYS_JSON = `{"activeKid":"a","keys":[{"kid":"a","d":${secretFragment}}]}`;
    const broken = await worker.fetch(
      new Request(`${issuer}/.well-known/jwks.json`),
      pasted,
    );
    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual({ error: "jwks_unavailable" });
    expect(log.mock.calls.flat().join(" ")).not.toContain(secretFragment);
  });

  it("verifies the GitHub run and mints an audience-bound short-lived assertion", async () => {
    mockGithubJwks();
    const token = await githubToken();
    const response = await mint(testEnv(), token, requestBody);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      issuer,
      audience: "sts.amazonaws.com",
      subject: "alethia-connector",
      run: requestBody.run,
    });
    const assertion = responseAssertion(body);
    const [encodedHeader, encodedPayload] = assertion.split(".");
    expect(decodePart(encodedHeader)).toMatchObject({
      alg: "RS256",
      kid: "active",
    });
    const claims = objectPart(encodedPayload);
    expect(claims).toMatchObject({
      iss: issuer,
      sub: "alethia-connector",
      aud: "sts.amazonaws.com",
      repository: requestBody.run.repository,
      run_id: requestBody.run.runId,
      provider: "aws",
    });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(600);
  });

  it("authenticates before it applies policy, so allowlists are not an oracle", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("no network")));
    vi.stubGlobal("fetch", fetchSpy);
    const missing = await worker.fetch(
      new Request(`${issuer}/v1/assertions`, {
        method: "POST",
        body: JSON.stringify(requestBody),
      }),
      testEnv(),
    );
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({
      error: "missing_bearer_token",
    });

    const unsigned = await mint(testEnv(), "unused", {
      ...requestBody,
      audience: "https://attacker.example",
    });
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toMatchObject({
      error: "invalid_github_token",
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    mockGithubJwks();
    const denied = await mint(testEnv(), await githubToken(), {
      ...requestBody,
      audience: "https://attacker.example",
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      error: "audience_not_allowed",
    });
  });

  it("pins each provider to the audience its federation trust expects", async () => {
    mockGithubJwks();
    const wrongCloud = await mint(testEnv(), await githubToken(), {
      ...requestBody,
      provider: "gcp",
    });
    expect(wrongCloud.status).toBe(403);
    expect(await wrongCloud.json()).toMatchObject({
      error: "audience_not_allowed",
    });
    const gcp = await mint(testEnv(), await githubToken({ jti: "gcp" }), {
      ...requestBody,
      provider: "gcp",
      audience: "alethia-gcp-wif",
    });
    expect(gcp.status).toBe(200);
  });

  it("refuses expired tokens and request metadata not bound to the authenticated run", async () => {
    mockGithubJwks();
    const expired = await githubToken({
      exp: Math.floor(Date.now() / 1000) - 120,
    });
    const expiredResponse = await mint(testEnv(), expired, requestBody);
    expect(expiredResponse.status).toBe(401);

    const valid = await githubToken();
    const mismatch = await mint(testEnv(), valid, {
      ...requestBody,
      run: { ...requestBody.run, runId: "999" },
    });
    expect(mismatch.status).toBe(403);
    expect(await mismatch.json()).toMatchObject({
      error: "run_binding_mismatch",
    });
  });

  it("reports a token at the end of its skew window as invalid, not as a guard outage", async () => {
    mockGithubJwks();
    const edge = await githubToken({
      exp: Math.floor(Date.now() / 1000) - 30,
    });
    const response = await mint(testEnv(), edge, requestBody);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: "invalid_github_token",
    });
  });

  it("refuses a GitHub token whose signed bytes have been changed", async () => {
    mockGithubJwks();
    const token = await githubToken();
    const segments = token.split(".");
    const signature = segments[2];
    if (!signature) throw new Error("test token has no signature");
    const replacement = signature.startsWith("A") ? "B" : "A";
    const altered = `${segments[0]}.${segments[1]}.${replacement}${signature.slice(1)}`;
    const response = await mint(testEnv(), altered, requestBody);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: "invalid_github_token",
    });
  });

  it("refuses every non-canonical spelling of a valid token, so replay cannot be evaded", async () => {
    mockGithubJwks();
    const env = testEnv();
    const token = await githubToken();
    const [header, payload, signature] = token.split(".");
    if (!header || !payload || !signature) throw new Error("bad test token");
    const spellings = [
      `${header}.${payload}.${signature}=`,
      `${header}.${payload}.${signature}==`,
      `${header}.${payload}.${signature.replaceAll("-", "+")}`,
      `${header}.${payload}.${signature.replaceAll("_", "/")}`,
      `${header}.${payload}=.${signature}`,
    ].filter((spelling) => spelling !== token);
    expect(spellings.length).toBeGreaterThanOrEqual(3);

    expect((await mint(env, token, requestBody)).status).toBe(200);
    for (const spelling of spellings) {
      const response = await mint(env, spelling, requestBody);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: "invalid_github_token",
      });
    }
    expect((await mint(env, token, requestBody)).status).toBe(409);
  });

  it("atomically refuses reuse of the same GitHub assertion by its jti", async () => {
    mockGithubJwks();
    const env = testEnv();
    const token = await githubToken({ jti: "one" });
    expect((await mint(env, token, requestBody)).status).toBe(200);
    const replay = await mint(env, token, requestBody);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({
      error: "github_token_replayed",
    });
    const missingJti = await githubToken({ jti: undefined });
    expect((await mint(env, missingJti, requestBody)).status).toBe(401);
  });

  it("selects GitHub's key by kid from a heterogeneous JWKS and refetches at a bounded rate", async () => {
    const fetchSpy = mockGithubJwks([
      { kty: "EC", crv: "P-256", x: "x", y: "y", kid: "ec" },
      { ...githubPublicJwk, alg: "RS256", use: "sig" },
      { ...githubPublicJwk, kid: "github", alg: "RS256", use: "sig" },
    ]);
    const env = testEnv();
    expect((await mint(env, await githubToken(), requestBody)).status).toBe(
      200,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(
      (await mint(env, await githubToken({ jti: "two" }), requestBody)).status,
    ).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const unknownKid = await githubToken({}, "rotated");
    expect((await mint(env, unknownKid, requestBody)).status).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not log bearer tokens or minted assertions", async () => {
    mockGithubJwks();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const token = await githubToken();
    const response = await mint(testEnv(), token, requestBody);
    const assertion = responseAssertion(await response.json());
    const output = log.mock.calls.flat().join(" ");
    expect(output).toContain(requestBody.run.runId);
    expect(output).toContain("minted");
    expect(output).not.toContain(token);
    expect(output).not.toContain(assertion);
  });
});

describe("ReplayGuard durable object", () => {
  it("consumes once, refuses the replay, and forgets on the expiry alarm", async () => {
    const state = memoryState();
    const guard = new ReplayGuard(state);
    const expiresAt = Date.now() + 60_000;
    expect((await guard.fetch(consume(expiresAt))).status).toBe(204);
    expect(state.alarms).toEqual([expiresAt]);
    expect((await guard.fetch(consume(expiresAt))).status).toBe(409);
    await guard.alarm();
    expect((await guard.fetch(consume(expiresAt))).status).toBe(204);
  });

  it("refuses an expiry in the past or of the wrong shape without consuming anything", async () => {
    const state = memoryState();
    const guard = new ReplayGuard(state);
    expect((await guard.fetch(consume(Date.now() - 1))).status).toBe(400);
    expect((await guard.fetch(consume("soon"))).status).toBe(400);
    expect(
      (await guard.fetch(new Request("https://replay.internal/consume")))
        .status,
    ).toBe(405);
    expect(state.entries.size).toBe(0);
    expect((await guard.fetch(consume(Date.now() + 1_000))).status).toBe(204);
  });
});

/** Builds one consume request for the replay guard. */
function consume(expiresAt: unknown): Request {
  return new Request("https://replay.internal/consume", {
    method: "POST",
    body: JSON.stringify({ expiresAt }),
  });
}

interface MemoryState extends DurableObjectState {
  entries: Map<string, unknown>;
  alarms: number[];
}

/** An in-memory Durable Object state with inspectable storage and alarms. */
function memoryState(): MemoryState {
  const entries = new Map<string, unknown>();
  const alarms: number[] = [];
  const storage: DurableObjectStorage = {
    async get<T>(key: string): Promise<T | undefined> {
      const value = entries.get(key);
      return isT<T>(value) ? value : undefined;
    },
    async put<T>(key: string, value: T): Promise<void> {
      entries.set(key, value);
    },
    async setAlarm(timestamp: number): Promise<void> {
      alarms.push(timestamp);
    },
    async deleteAll(): Promise<void> {
      entries.clear();
    },
  };
  return { storage, entries, alarms };
}

/** The in-memory store holds whatever was put; a stored value is by construction its own type. */
function isT<T>(value: unknown): value is T {
  return value !== undefined;
}

/** Creates an isolated environment with an atomic in-memory replay namespace. */
function testEnv(): Env {
  const consumed = new Set<string>();
  let selected = "";
  return {
    ISSUER_URL: issuer,
    GITHUB_TOKEN_AUDIENCE: githubAudience,
    ALLOWED_REPOSITORIES: requestBody.run.repository,
    ALLOWED_WORKFLOW_REFS: workflowRef,
    SIGNING_KEYS_JSON: JSON.stringify({
      activeKid: "active",
      keys: [
        signingJwk(brokerPrivateJwk, "active"),
        signingJwk(oldBrokerPrivateJwk, "previous"),
      ],
    }),
    REPLAY_GUARD: {
      idFromName(name) {
        selected = name;
        return {};
      },
      get() {
        return {
          async fetch() {
            if (consumed.has(selected))
              return new Response("replayed", { status: 409 });
            consumed.add(selected);
            return new Response(null, { status: 204 });
          },
        };
      },
    },
  };
}

/** Calls the protected mint route with a bearer token. */
function mint(env: Env, token: string, body: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`${issuer}/v1/assertions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
    env,
  );
}

/** Generates an extractable RSA key pair for test JWTs. */
async function generateRsaKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
}

/** Builds a private signing JWK with public rotation metadata. */
function signingJwk(key: JsonWebKey, kid: string): TestJwk {
  return { ...key, kid, alg: "RS256", use: "sig" };
}

/** Keeps only the public RSA parameters of a private JWK, as a retained rotation entry would. */
function publicHalf(key: JsonWebKey): JsonWebKey {
  return { kty: key.kty, n: key.n, e: key.e };
}

/** Stubs GitHub's JWKS endpoint; by default with the one test verification key. */
function mockGithubJwks(keys?: unknown[]): Mock<() => Promise<Response>> {
  const spy = vi.fn(() =>
    Promise.resolve(
      Response.json({
        keys: keys ?? [
          { ...githubPublicJwk, kid: "github", alg: "RS256", use: "sig" },
        ],
      }),
    ),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** Signs a GitHub-like OIDC token, with optional claim overrides and header kid. */
async function githubToken(
  overrides: { [key: string]: unknown } = {},
  kid = "github",
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = encodePart({ alg: "RS256", typ: "JWT", kid });
  const payload = encodePart({
    iss: "https://token.actions.githubusercontent.com",
    aud: githubAudience,
    iat: now,
    nbf: now - 5,
    exp: now + 300,
    jti: crypto.randomUUID(),
    repository: requestBody.run.repository,
    workflow_ref: workflowRef,
    run_id: requestBody.run.runId,
    run_attempt: String(requestBody.run.runAttempt),
    ...overrides,
  });
  const input = new TextEncoder().encode(`${header}.${payload}`);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    githubPrivateKey,
    input,
  );
  return `${header}.${payload}.${encodeBytes(new Uint8Array(signature))}`;
}

/** Encodes one JSON JWT segment. */
function encodePart(value: unknown): string {
  return encodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

/** Encodes bytes as unpadded URL-safe Base64. */
function encodeBytes(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** Decodes one JWT JSON segment for assertions. */
function decodePart(value: string | undefined): unknown {
  if (!value) throw new Error("missing JWT segment");
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return JSON.parse(atob(padded));
}

/** Decodes one JWT object payload for numeric claim assertions. */
function objectPart(value: string | undefined): { [key: string]: unknown } {
  const decoded = decodePart(value);
  if (!isUnknownMap(decoded)) {
    throw new Error("JWT segment is not an object");
  }
  return decoded;
}

/** Narrows decoded JSON to an object with addressable claims. */
function isUnknownMap(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrows a JSON response to its assertion field. */
function responseAssertion(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !("assertion" in value) ||
    typeof value.assertion !== "string"
  ) {
    throw new Error("response did not contain an assertion");
  }
  return value.assertion;
}
