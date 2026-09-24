#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// The cli-demo nightly's PRE-SPEND proof that the E2E assertion broker path works on one cloud
// (#4227). It does, in order, the exact exchange the console under test will do — and then the one
// the cloud will do:
//
//   1. asks GitHub's runner endpoint for a fresh OIDC token bound to the broker's audience;
//   2. exchanges it at the broker (apps/e2e-issuer, POST /v1/assertions) for a short-lived,
//      run-bound `alethia-connector` assertion for this cloud;
//   3. checks every claim of that assertion against what was asked for — the same checks the
//      console's broker source makes (apps/console/lib/oidc/assertion-source.ts);
//   4. presents the assertion to the cloud's own token service (AWS STS, Google STS + IAM
//      Credentials, Entra) and requires a credential back — which is the only thing that proves the
//      #4226 trust is APPLIED, rather than committed;
//   5. discards every token it holds. Nothing is persisted, and nothing secret is printed.
//
// "refresh" is the name the issue's scope gave this file. It mints a FRESH token and assertion on
// every call and never stores one: the console requests its own on demand (one GitHub token per
// assertion — the broker consumes each token's `jti` once), so there is no file to refresh.
//
// WHY BEFORE THE CONSOLE BUILD. A cli-demo leg builds ee and the console (~10 min) before `go test`
// reaches the connector beat. A trust that was never applied, a broker allowlist that does not name
// this workflow, or an audience that disagrees between the broker and this repo each fail there as
// "connector exited 1" — after the spend on the build, and with the cause several layers away. Here
// each one fails in seconds and names itself.
//
// OUTCOMES (the exit code is the contract the workflow reads):
//
//   0   PROVEN   — the broker minted, the claims check, and the cloud accepted the assertion.
//   10  SKIPPED  — the broker trust is not wired for this cloud (a variable is absent). A notice,
//                  never a red: the maintainer has not opted in yet, which is not a failure.
//   1   REFUSED  — wired, and something in the chain said no. The message names the link.
//   2   USAGE    — a bad invocation (including alibaba, excluded by maintainer ruling).
//
//   node scripts/e2e/refresh-e2e-issuer-token.mjs prove --provider <aws|gcp|azure> [--gcp-wif-config-out <path>]
//   node scripts/e2e/refresh-e2e-issuer-token.mjs --self-test
//
// INPUTS (environment). Repository VARIABLES, not secrets — an origin, an audience, a role ARN and
// a pool name are identifiers:
//
//   E2E_ISSUER_URL               the broker origin (apps/e2e-issuer/README.md) — the SAME value the
//                                four trust stacks pin as e2e_broker_issuer_url
//   E2E_ISSUER_GITHUB_AUDIENCE   the audience the broker requires on the GitHub token — MUST equal
//                                the broker's GITHUB_TOKEN_AUDIENCE on the `e2e-issuer` environment
//   E2E_GCP_BROKER_WIF_AUDIENCE  gcp only: infra/gcp-e2e's `e2e_broker_gcp_wif_audience` output
//   E2E_AWS_ROLE_ARN · E2E_GCP_SA_EMAIL · E2E_AZURE_TENANT_ID · E2E_AZURE_CLIENT_ID
//   ACTIONS_ID_TOKEN_REQUEST_URL / _TOKEN, GITHUB_REPOSITORY / _WORKFLOW_REF / _RUN_ID / _RUN_ATTEMPT
//
// The audiences and the subject are READ from packages/workload-identity/src/broker.ts — the one
// copy (#4236) — never typed here.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BROKER_CONTRACT = path.join(REPO_ROOT, "packages", "workload-identity", "src", "broker.ts");

export const EXIT_PROVEN = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;
export const EXIT_SKIPPED = 10;

/** The clouds this proof covers. Alibaba is excluded by maintainer ruling (#4227); hetzner has no issuer. */
export const BROKER_CLOUDS = ["aws", "gcp", "azure"];

/** Every network call is bounded: a stalled endpoint must fail the proof, not hang the job. */
const FETCH_TIMEOUT_MS = 20_000;
/** A response larger than this is not one of the documents this script reads. */
const MAX_BODY_BYTES = 65_536;
/** The console's own tolerance for the assertion's `iat` (assertion-source.ts). */
const CLOCK_SKEW_SECONDS = 30;
/** The GCP STS/IAM token type constants — Google's, not ours. */
const GCP_TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
const GCP_JWT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";
const GCP_ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
/** The runner-side token path the product's own WIF config names (apps/console/lib/cloud-providers/gcp-wif.ts). */
const GCP_RUNNER_TOKEN_PATH = "/var/run/alethia/gcp-oidc-token";

/** A failure whose message is built only from constants and non-secret identifiers. */
export class ProofError extends Error {
  /** Carries the exit code the failure maps to. */
  constructor(code, message) {
    super(message);
    this.exitCode = code;
  }
}

/**
 * Reads the broker contract (audiences, subject, TTL bounds) out of broker.ts. The same regexes
 * infra/*-e2e/e2e-broker.tf use, so a moved file or a changed shape fails HERE, closed, rather than
 * minting for an audience nobody pins.
 */
export function parseBrokerContract(source) {
  const block = /WORKLOAD_PROVIDER_AUDIENCES[^=]*=\s*\{([^}]*)\}/.exec(source)?.[1];
  const subject = /WORKLOAD_SUBJECT\s*=\s*"([^"]+)"/.exec(source)?.[1];
  const minTtl = Number(/MIN_ASSERTION_TTL_SECONDS\s*=\s*(\d+)/.exec(source)?.[1]);
  const maxTtl = Number(/MAX_ASSERTION_TTL_SECONDS\s*=\s*(\d+)/.exec(source)?.[1]);
  if (!block || !subject || !Number.isInteger(minTtl) || !Number.isInteger(maxTtl) || minTtl > maxTtl) {
    throw new ProofError(
      EXIT_REFUSED,
      "could not read the broker contract from packages/workload-identity/src/broker.ts — its shape changed; update this reader rather than restating the values",
    );
  }
  const audiences = {};
  for (const provider of BROKER_CLOUDS) {
    const audience = new RegExp(`\\b${provider}:\\s*"([^"]+)"`).exec(block)?.[1];
    if (!audience) {
      throw new ProofError(EXIT_REFUSED, `broker.ts names no audience for ${provider}`);
    }
    audiences[provider] = audience;
  }
  return { audiences, subject, minTtl, maxTtl };
}

/** Reads the one copy of the broker contract from the working tree. */
export function loadBrokerContract(file = BROKER_CONTRACT) {
  return parseBrokerContract(fs.readFileSync(file, "utf8"));
}

/** The variables whose absence means "the broker trust is not wired for this cloud" (a skip, not a failure). */
export function trustVariables(provider) {
  const common = ["E2E_ISSUER_URL", "E2E_ISSUER_GITHUB_AUDIENCE"];
  return provider === "gcp" ? [...common, "E2E_GCP_BROKER_WIF_AUDIENCE"] : common;
}

/** The variables the proof needs once the trust IS wired; absent here is a broken run, not an opt-out. */
function runVariables(provider) {
  const runtime = [
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "GITHUB_REPOSITORY",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
  ];
  const cloud = {
    aws: ["E2E_AWS_ROLE_ARN"],
    gcp: ["E2E_GCP_SA_EMAIL"],
    azure: ["E2E_AZURE_TENANT_ID", "E2E_AZURE_CLIENT_ID"],
  }[provider];
  return [...runtime, ...cloud];
}

/**
 * Resolves the run's configuration, or reports which trust variables are absent. Validates every
 * value that later becomes part of a URL, so no input can point a bearer token at another host.
 */
export function resolveConfig(provider, env) {
  if (!BROKER_CLOUDS.includes(provider)) {
    throw new ProofError(
      EXIT_USAGE,
      provider === "alibaba"
        ? "alibaba is excluded from the broker proof by maintainer ruling (#4227) — the cli-demo scope is hetzner, aws, gcp and azure"
        : `--provider must be one of ${BROKER_CLOUDS.join(", ")}`,
    );
  }
  const value = (name) => (env[name] ?? "").trim();
  const absent = trustVariables(provider).filter((name) => !value(name));
  if (absent.length > 0) return { absent };

  const missing = runVariables(provider).filter((name) => !value(name));
  if (missing.length > 0) {
    throw new ProofError(
      EXIT_REFUSED,
      `the broker trust is wired but the run lacks ${missing.join(", ")} — the job needs \`id-token: write\` and the cloud's e2e variables`,
    );
  }

  const runAttempt = Number(value("GITHUB_RUN_ATTEMPT"));
  if (!Number.isInteger(runAttempt) || runAttempt < 1) {
    throw new ProofError(EXIT_REFUSED, "GITHUB_RUN_ATTEMPT is not a positive integer");
  }
  if (!/^\d{1,30}$/.test(value("GITHUB_RUN_ID"))) {
    throw new ProofError(EXIT_REFUSED, "GITHUB_RUN_ID is not a run id");
  }
  const config = {
    provider,
    issuer: httpsOrigin(value("E2E_ISSUER_URL"), "E2E_ISSUER_URL"),
    githubAudience: value("E2E_ISSUER_GITHUB_AUDIENCE"),
    githubRequestUrl: githubOidcUrl(value("ACTIONS_ID_TOKEN_REQUEST_URL")),
    githubRequestToken: value("ACTIONS_ID_TOKEN_REQUEST_TOKEN"),
    run: {
      repository: value("GITHUB_REPOSITORY"),
      workflowRef: value("GITHUB_WORKFLOW_REF"),
      runId: value("GITHUB_RUN_ID"),
      runAttempt,
    },
  };
  if (provider === "aws") {
    config.roleArn = value("E2E_AWS_ROLE_ARN");
    if (!/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/.test(config.roleArn)) {
      throw new ProofError(EXIT_REFUSED, "E2E_AWS_ROLE_ARN is not an IAM role ARN");
    }
    config.awsRegion = value("E2E_REGION") || "us-east-1";
    if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(config.awsRegion)) {
      throw new ProofError(EXIT_REFUSED, "E2E_REGION is not an AWS region");
    }
  }
  if (provider === "gcp") {
    config.wifAudience = value("E2E_GCP_BROKER_WIF_AUDIENCE");
    if (
      !/^\/\/iam\.googleapis\.com\/projects\/\d{1,20}\/locations\/global\/workloadIdentityPools\/[a-z0-9-]{4,32}\/providers\/[a-z0-9-]{4,32}$/.test(
        config.wifAudience,
      )
    ) {
      throw new ProofError(
        EXIT_REFUSED,
        "E2E_GCP_BROKER_WIF_AUDIENCE is not a workload identity provider name — set it to infra/gcp-e2e's e2e_broker_gcp_wif_audience output",
      );
    }
    config.serviceAccount = value("E2E_GCP_SA_EMAIL");
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/.test(config.serviceAccount)) {
      throw new ProofError(EXIT_REFUSED, "E2E_GCP_SA_EMAIL is not a service account email");
    }
  }
  if (provider === "azure") {
    const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    config.tenantId = value("E2E_AZURE_TENANT_ID");
    config.clientId = value("E2E_AZURE_CLIENT_ID");
    if (!guid.test(config.tenantId) || !guid.test(config.clientId)) {
      throw new ProofError(EXIT_REFUSED, "E2E_AZURE_TENANT_ID / E2E_AZURE_CLIENT_ID must be GUIDs");
    }
  }
  return { config };
}

/** Accepts only a bare HTTPS origin, so the assertion request cannot be sent to a path or a userinfo host. */
function httpsOrigin(raw, name) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ProofError(EXIT_REFUSED, `${name} is not a URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new ProofError(EXIT_REFUSED, `${name} must be a bare HTTPS origin`);
  }
  return url.origin;
}

/** Restricts the GitHub token request to GitHub's Actions host family (the console's own rule). */
function githubOidcUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ProofError(EXIT_REFUSED, "ACTIONS_ID_TOKEN_REQUEST_URL is not a URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname.endsWith(".actions.githubusercontent.com")) {
    throw new ProofError(EXIT_REFUSED, "ACTIONS_ID_TOKEN_REQUEST_URL is not a GitHub Actions HTTPS URL");
  }
  return url.toString();
}

/** One bounded HTTP call that never follows a redirect (a redirect would carry a bearer to another host). */
async function call(fetchImpl, url, init) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    // The underlying error can quote the request; this message names only the host.
    throw new ProofError(EXIT_REFUSED, `${new URL(url).host} did not answer (network error or ${FETCH_TIMEOUT_MS / 1000}s timeout)`);
  }
  const text = await response.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new ProofError(EXIT_REFUSED, `${new URL(url).host} returned an oversized response (HTTP ${response.status})`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, ok: response.ok, text, json };
}

/** Only a short identifier (a code, a request id, a kid) from a remote body is ever echoed; anything else is withheld. */
function safeCode(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : "<withheld>";
}

/** Requests a fresh GitHub OIDC token bound to the broker's audience. */
async function requestGithubToken(fetchImpl, config) {
  const url = new URL(config.githubRequestUrl);
  url.searchParams.set("audience", config.githubAudience);
  const res = await call(fetchImpl, url.toString(), {
    headers: { authorization: `Bearer ${config.githubRequestToken}` },
  });
  if (!res.ok) throw new ProofError(EXIT_REFUSED, `GitHub refused the OIDC token request (HTTP ${res.status})`);
  const token = res.json?.value;
  if (typeof token !== "string" || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token) || token.length > 16_384) {
    throw new ProofError(EXIT_REFUSED, "GitHub returned a malformed OIDC token response");
  }
  return token;
}

/** What a broker refusal most likely means, per the codes apps/e2e-issuer/src/worker.ts emits. */
const BROKER_REFUSAL_HINTS = {
  invalid_github_token:
    "the GitHub token did not verify — most often E2E_ISSUER_GITHUB_AUDIENCE differs from the broker's GITHUB_TOKEN_AUDIENCE",
  workflow_not_allowed:
    "the broker's ALLOWED_WORKFLOW_REFS does not name this run's workflow ref — the trust admits e2e-nightly.yml on dev only, so dispatch from dev",
  repository_not_allowed: "the broker's ALLOWED_REPOSITORIES does not name this repository",
  audience_not_allowed: "the broker and this tree disagree about the provider audience in broker.ts — the broker is running older code",
  run_binding_mismatch: "the run metadata sent does not match the GitHub token's claims",
  github_token_replayed: "the GitHub token was already consumed — a token was reused, which this script never does",
  issuer_origin_mismatch: "E2E_ISSUER_URL is not the origin the broker is deployed for",
  not_found: "E2E_ISSUER_URL answers, but not as the assertion broker",
};

/** Exchanges the GitHub token for a run-bound broker assertion for this cloud. */
async function requestAssertion(fetchImpl, config, contract, githubToken) {
  const res = await call(fetchImpl, `${config.issuer}/v1/assertions`, {
    method: "POST",
    headers: { authorization: `Bearer ${githubToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      provider: config.provider,
      audience: contract.audiences[config.provider],
      subject: contract.subject,
      // The narrowest lifetime the contract allows: this assertion exists to be checked once.
      ttlSeconds: contract.minTtl,
      run: config.run,
    }),
  });
  if (!res.ok) {
    const code = safeCode(res.json?.error);
    const requestId = safeCode(res.json?.requestId);
    const hint = BROKER_REFUSAL_HINTS[code] ?? "see the broker's own log for this request id";
    throw new ProofError(
      EXIT_REFUSED,
      `the broker refused the assertion (HTTP ${res.status}, ${code}, request ${requestId}): ${hint}` +
        (code === "workflow_not_allowed" ? ` [this run: ${config.run.workflowRef}]` : ""),
    );
  }
  return res.json;
}

/** Decodes one base64url JWT segment as JSON, or undefined. */
function decodeSegment(segment) {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Checks the broker's answer against the request, claim by claim — the console's
 * validateBrokerAssertion, plus the header. Returns the non-secret facts worth reporting.
 * Every rejection names the CLAIM, never its value.
 */
export function validateBrokerResponse(body, config, contract, nowSeconds) {
  const refuse = (what) => {
    throw new ProofError(EXIT_REFUSED, `the broker's assertion is outside the requested scope: ${what}`);
  };
  if (typeof body !== "object" || body === null) refuse("the response is not a JSON object");
  const parts = typeof body.assertion === "string" ? body.assertion.split(".") : [];
  if (parts.length !== 3 || parts.some((p) => !/^[\w-]+$/.test(p))) refuse("the assertion is not a compact JWT");
  const header = decodeSegment(parts[0]);
  const claims = decodeSegment(parts[1]);
  if (!header || !claims) refuse("the assertion does not decode");
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) refuse("header alg/kid");

  const audience = contract.audiences[config.provider];
  const ttl = contract.minTtl;
  const expiresAt = Math.floor(Date.parse(body.expiresAt) / 1000);
  const checks = [
    ["response issuer", body.issuer === config.issuer],
    ["iss", claims.iss === config.issuer],
    ["response audience", body.audience === audience],
    ["aud", claims.aud === audience],
    ["response subject", body.subject === contract.subject],
    ["sub", claims.sub === contract.subject],
    ["provider", claims.provider === config.provider],
    ["iat", typeof claims.iat === "number" && Math.abs(claims.iat - nowSeconds) <= CLOCK_SKEW_SECONDS],
    ["exp", typeof claims.exp === "number" && claims.exp === expiresAt],
    ["lifetime", typeof claims.exp === "number" && typeof claims.iat === "number" && claims.exp - claims.iat === ttl],
    ["repository", claims.repository === config.run.repository],
    ["workflow_ref", claims.workflow_ref === config.run.workflowRef],
    ["run_id", claims.run_id === config.run.runId],
    ["run_attempt", Number(claims.run_attempt) === config.run.runAttempt],
    [
      "response run",
      body.run?.repository === config.run.repository &&
        body.run?.workflowRef === config.run.workflowRef &&
        body.run?.runId === config.run.runId &&
        body.run?.runAttempt === config.run.runAttempt,
    ],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) refuse(failed.join(", "));
  return { kid: header.kid, ttl };
}

/** Presents the assertion to AWS STS as AssumeRoleWithWebIdentity; the credential it returns is discarded. */
async function proveAws(fetchImpl, config, assertion) {
  const form = new URLSearchParams({
    Action: "AssumeRoleWithWebIdentity",
    Version: "2011-06-15",
    RoleArn: config.roleArn,
    RoleSessionName: `alethia-e2e-broker-${config.run.runId}-${config.run.runAttempt}`.slice(0, 64),
    WebIdentityToken: assertion,
    DurationSeconds: "900",
  });
  const res = await call(fetchImpl, `https://sts.${config.awsRegion}.amazonaws.com/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form.toString(),
  });
  const credentials =
    res.json?.AssumeRoleWithWebIdentityResponse?.AssumeRoleWithWebIdentityResult?.Credentials ??
    (/<AccessKeyId>/.test(res.text) ? {} : undefined);
  if (res.ok && credentials) return "AWS STS AssumeRoleWithWebIdentity";
  const code = safeCode(res.json?.Error?.Code ?? /<Code>([^<]{1,64})<\/Code>/.exec(res.text)?.[1]);
  throw new ProofError(
    EXIT_REFUSED,
    `AWS STS refused the broker assertion (HTTP ${res.status}, ${code}) — the E2EBrokerAssertion trust on E2E_AWS_ROLE_ARN is not applied, or names another issuer (infra/aws-oidc, #4226)`,
  );
}

/** Exchanges the assertion at Google STS, then impersonates the e2e SA with it; both tokens are discarded. */
async function proveGcp(fetchImpl, config, assertion) {
  const sts = await call(fetchImpl, "https://sts.googleapis.com/v1/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: GCP_TOKEN_EXCHANGE,
      audience: config.wifAudience,
      scope: CLOUD_PLATFORM_SCOPE,
      requested_token_type: GCP_ACCESS_TOKEN_TYPE,
      subject_token_type: GCP_JWT_TOKEN_TYPE,
      subject_token: assertion,
    }),
  });
  const federated = sts.json?.access_token;
  if (!sts.ok || typeof federated !== "string" || !federated) {
    throw new ProofError(
      EXIT_REFUSED,
      `Google STS refused the broker assertion (HTTP ${sts.status}, ${safeCode(sts.json?.error)}) — the alethia-e2e-broker pool/provider is not applied, or its attribute condition does not admit this run (infra/gcp-e2e, #4226)`,
    );
  }
  const sa = await call(
    fetchImpl,
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${config.serviceAccount}:generateAccessToken`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${federated}`, "content-type": "application/json" },
      body: JSON.stringify({ scope: [CLOUD_PLATFORM_SCOPE], lifetime: "300s" }),
    },
  );
  if (!sa.ok || typeof sa.json?.accessToken !== "string") {
    throw new ProofError(
      EXIT_REFUSED,
      `IAM Credentials refused to impersonate E2E_GCP_SA_EMAIL with the broker identity (HTTP ${sa.status}, ${safeCode(sa.json?.error?.status)}) — the e2e_broker roles/iam.workloadIdentityUser member is not applied (infra/gcp-e2e, #4226)`,
    );
  }
  return "Google STS + IAM Credentials generateAccessToken";
}

/** Presents the assertion to Entra as a client assertion for the e2e application; the token is discarded. */
async function proveAzure(fetchImpl, config, assertion) {
  const form = new URLSearchParams({
    client_id: config.clientId,
    scope: "https://management.azure.com/.default",
    grant_type: "client_credentials",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  });
  const res = await call(fetchImpl, `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (res.ok && typeof res.json?.access_token === "string") return "Entra client-credentials (federated)";
  const first = Array.isArray(res.json?.error_codes) ? res.json.error_codes[0] : undefined;
  const code = Number.isInteger(first) ? `AADSTS${first}` : safeCode(res.json?.error);
  throw new ProofError(
    EXIT_REFUSED,
    `Entra refused the broker assertion (HTTP ${res.status}, ${code}) — the e2e-assertion-broker federated credential is not applied, or names another issuer (infra/azure-e2e, #4226)`,
  );
}

/**
 * The WIF config `connector gcp --wif-config` uploads on the broker path: the BROKER pool's provider
 * as audience and the e2e SA to impersonate. The console never reads credential_source — it supplies
 * the subject token itself from its assertion source (apps/console/lib/cloud-providers/session/gcp.ts)
 * — but parseWifConfig requires one, so it names the product's own runner path. No secret in it.
 */
export function gcpBrokerWifConfig(config) {
  return {
    type: "external_account",
    audience: config.wifAudience,
    subject_token_type: GCP_JWT_TOKEN_TYPE,
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${config.serviceAccount}:generateAccessToken`,
    credential_source: { file: GCP_RUNNER_TOKEN_PATH, format: { type: "text" } },
  };
}

/**
 * Runs the whole proof for one cloud. Dependencies are injected so the self-test drives the same
 * code the workflow does. Returns { exitCode, lines } — every line is safe to print.
 */
export async function prove({ provider, env, fetchImpl, contract, nowSeconds, gcpWifConfigOut, writeFile }) {
  const resolved = resolveConfig(provider, env);
  if (resolved.absent) {
    return {
      exitCode: EXIT_SKIPPED,
      lines: [
        `::notice::cli-demo broker proof SKIPPED for ${provider} — the E2E assertion broker trust is not wired (${resolved.absent.join(", ")} unset). ` +
          "Nothing was minted and nothing was spent. To enable: apply #4226's trust for this cloud, then set the variable(s) — docs/testing/e2e-federation-apply-runbook.md part two.",
      ],
    };
  }
  const { config } = resolved;
  const githubToken = await requestGithubToken(fetchImpl, config);
  const body = await requestAssertion(fetchImpl, config, contract, githubToken);
  const facts = validateBrokerResponse(body, config, contract, nowSeconds());
  const prover = { aws: proveAws, gcp: proveGcp, azure: proveAzure }[provider];
  const acceptedBy = await prover(fetchImpl, config, body.assertion);
  const lines = [
    `::notice::cli-demo broker proof PROVEN for ${provider}: the broker minted a ${facts.ttl}s run-bound assertion (kid ${safeCode(facts.kid)}) and ${acceptedBy} accepted it. Every token was discarded.`,
  ];
  if (provider === "gcp" && gcpWifConfigOut) {
    writeFile(gcpWifConfigOut, `${JSON.stringify(gcpBrokerWifConfig(config), null, 2)}\n`);
    lines.push(`wrote the broker WIF config for \`connector gcp --wif-config\` (${path.basename(gcpWifConfigOut)})`);
  }
  return { exitCode: EXIT_PROVEN, lines };
}

/** Removes every occurrence of each secret from a message — the last line of defence for a thrown error. */
export function redact(message, secrets) {
  let out = String(message);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) out = out.split(secret).join("<redacted>");
  }
  return out;
}

/** Parses argv into { command, provider, gcpWifConfigOut } or throws a usage error. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "prove") throw new ProofError(EXIT_USAGE, "usage: refresh-e2e-issuer-token.mjs prove --provider <aws|gcp|azure> [--gcp-wif-config-out <path>] | --self-test");
  const opts = { command, provider: "", gcpWifConfigOut: "" };
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, val] = [rest[i], rest[i + 1]];
    if (val === undefined) throw new ProofError(EXIT_USAGE, `${flag} needs a value`);
    if (flag === "--provider") opts.provider = val;
    else if (flag === "--gcp-wif-config-out") opts.gcpWifConfigOut = val;
    else throw new ProofError(EXIT_USAGE, `unknown flag ${flag}`);
  }
  if (!opts.provider) throw new ProofError(EXIT_USAGE, "--provider is required");
  return opts;
}

// ── self-test ────────────────────────────────────────────────────────────────────────────────

/** Encodes a JSON value as one base64url JWT segment. */
function segment(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Runs the offline self-test: every branch the workflow depends on, including the refusals. */
async function runSelfTest() {
  let failures = 0;
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`ok   ${name}`);
    else {
      failures++;
      console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    }
  };

  const contract = loadBrokerContract();
  check("contract: aws audience read from broker.ts", contract.audiences.aws === "sts.amazonaws.com");
  check("contract: gcp audience read from broker.ts", contract.audiences.gcp === "alethia-gcp-wif");
  check("contract: azure audience read from broker.ts", contract.audiences.azure === "api://AzureADTokenExchange");
  check("contract: subject read from broker.ts", contract.subject === "alethia-connector");
  check("contract: narrowest ttl read from broker.ts", contract.minTtl === 60 && contract.maxTtl === 600);
  let mangled;
  try {
    parseBrokerContract("export const WORKLOAD_SUBJECT = 'x';");
  } catch (e) {
    mangled = e;
  }
  check("contract: a changed shape fails closed", mangled instanceof ProofError && mangled.exitCode === EXIT_REFUSED);

  const NOW = 1_800_000_000;
  const SECRETS = {
    requestToken: "REQUEST-TOKEN-SENTINEL-0001",
    githubToken: `${segment({ alg: "RS256" })}.${segment({ sentinel: "GITHUB-TOKEN-SENTINEL" })}.c2ln`,
    stsSecret: "CLOUD-SECRET-SENTINEL-0003",
  };
  const baseEnv = {
    E2E_ISSUER_URL: "https://e2e-issuer.example.test",
    E2E_ISSUER_GITHUB_AUDIENCE: "https://e2e-issuer.example.test",
    E2E_GCP_BROKER_WIF_AUDIENCE:
      "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/alethia-e2e-broker/providers/alethia-e2e-broker-oidc",
    E2E_AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/alethia-e2e-nightly",
    E2E_GCP_SA_EMAIL: "alethia-e2e@alethia-e2e-proj.iam.gserviceaccount.com",
    E2E_AZURE_TENANT_ID: "11111111-2222-3333-4444-555555555555",
    E2E_AZURE_CLIENT_ID: "66666666-7777-8888-9999-000000000000",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/abc/idtoken?api-version=2.0",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: SECRETS.requestToken,
    GITHUB_REPOSITORY: "alethialabs-io/alethialabs",
    GITHUB_WORKFLOW_REF: "alethialabs-io/alethialabs/.github/workflows/e2e-nightly.yml@refs/heads/dev",
    GITHUB_RUN_ID: "424242",
    GITHUB_RUN_ATTEMPT: "2",
  };
  const run = {
    repository: baseEnv.GITHUB_REPOSITORY,
    workflowRef: baseEnv.GITHUB_WORKFLOW_REF,
    runId: baseEnv.GITHUB_RUN_ID,
    runAttempt: 2,
  };

  /** Builds the broker response for provider, with optional claim/field overrides. */
  const brokerBody = (provider, claimOver = {}, bodyOver = {}) => {
    const claims = {
      iss: baseEnv.E2E_ISSUER_URL,
      sub: "alethia-connector",
      aud: contract.audiences[provider],
      iat: NOW,
      nbf: NOW - 30,
      exp: NOW + 60,
      jti: "j",
      repository: run.repository,
      workflow_ref: run.workflowRef,
      run_id: run.runId,
      run_attempt: run.runAttempt,
      provider,
      ...claimOver,
    };
    const assertion = `${segment({ alg: "RS256", kid: "2026-09", typ: "JWT" })}.${segment(claims)}.c2lnbmF0dXJl`;
    return {
      assertion,
      issuer: baseEnv.E2E_ISSUER_URL,
      audience: contract.audiences[provider],
      subject: "alethia-connector",
      expiresAt: new Date((claims.exp ?? NOW + 60) * 1000).toISOString(),
      run,
      ...bodyOver,
    };
  };

  /** A fake fetch: routes by host, records every request, answers from the scenario. */
  const fakeFetch = (scenario) => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init });
      const host = new URL(url).host;
      const reply = (status, body) =>
        new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
      if (host.endsWith(".actions.githubusercontent.com")) return reply(200, { value: SECRETS.githubToken });
      if (host === "e2e-issuer.example.test") return reply(scenario.brokerStatus ?? 200, scenario.broker);
      if (host.startsWith("sts.") && host.endsWith(".amazonaws.com"))
        return scenario.awsOk === false
          ? reply(403, "<ErrorResponse><Error><Code>AccessDenied</Code><Message>Not authorized</Message></Error></ErrorResponse>")
          : reply(200, { AssumeRoleWithWebIdentityResponse: { AssumeRoleWithWebIdentityResult: { Credentials: { SecretAccessKey: SECRETS.stsSecret } } } });
      if (host === "sts.googleapis.com")
        return scenario.gcpStsOk === false ? reply(400, { error: "invalid_grant" }) : reply(200, { access_token: SECRETS.stsSecret });
      if (host === "iamcredentials.googleapis.com")
        return scenario.gcpSaOk === false
          ? reply(403, { error: { status: "PERMISSION_DENIED" } })
          : reply(200, { accessToken: SECRETS.stsSecret });
      if (host === "login.microsoftonline.com")
        return scenario.azureOk === false
          ? reply(400, { error: "invalid_client", error_codes: [70021] })
          : reply(200, { access_token: SECRETS.stsSecret });
      return reply(599, "unexpected host");
    };
    return { fetchImpl, calls };
  };

  /** Runs prove() and captures its outcome as { exitCode, text }, redacting exactly as main() does. */
  const runProve = async (provider, env, scenario, extra = {}) => {
    const { fetchImpl, calls } = fakeFetch(scenario);
    const written = {};
    try {
      const out = await prove({
        provider,
        env,
        fetchImpl,
        contract,
        nowSeconds: () => NOW,
        writeFile: (p, c) => {
          written[p] = c;
        },
        ...extra,
      });
      return { exitCode: out.exitCode, text: out.lines.join("\n"), calls, written };
    } catch (e) {
      const code = e instanceof ProofError ? e.exitCode : EXIT_REFUSED;
      return { exitCode: code, text: redact(e.message, Object.values(SECRETS)), calls, written, raw: e.message };
    }
  };
  const leaks = (text) => Object.values(SECRETS).filter((s) => text.includes(s) || text.includes("SENTINEL"));

  // Absent trust → SKIP, green, before any network call.
  for (const [provider, unset] of [["aws", "E2E_ISSUER_URL"], ["azure", "E2E_ISSUER_GITHUB_AUDIENCE"], ["gcp", "E2E_GCP_BROKER_WIF_AUDIENCE"]]) {
    const env = { ...baseEnv, [unset]: "" };
    const r = await runProve(provider, env, {});
    check(`skip: ${provider} with ${unset} unset exits ${EXIT_SKIPPED}`, r.exitCode === EXIT_SKIPPED, `got ${r.exitCode}`);
    check(`skip: ${provider} names ${unset}`, r.text.includes(unset) && r.text.startsWith("::notice::"));
    check(`skip: ${provider} makes no network call`, r.calls.length === 0);
  }
  // A missing GCP broker audience does NOT skip aws: the gcp-only variable is gcp's alone.
  {
    const r = await runProve("aws", { ...baseEnv, E2E_GCP_BROKER_WIF_AUDIENCE: "" }, { broker: brokerBody("aws") });
    check("skip: the gcp-only variable does not gate aws", r.exitCode === EXIT_PROVEN, `got ${r.exitCode}: ${r.text}`);
  }

  // Happy path on every cloud: the exact requests, the verdict, and no secret in the output.
  for (const provider of BROKER_CLOUDS) {
    const out = "/tmp/never-written-by-self-test.json";
    const r = await runProve(provider, baseEnv, { broker: brokerBody(provider) }, { gcpWifConfigOut: out });
    check(`proven: ${provider} exits 0`, r.exitCode === EXIT_PROVEN, `got ${r.exitCode}: ${r.text}`);
    check(`proven: ${provider} prints no secret`, leaks(r.text).length === 0);
    const gh = r.calls[0];
    check(
      `proven: ${provider} asks GitHub for the broker audience with the request token`,
      gh && new URL(gh.url).searchParams.get("audience") === baseEnv.E2E_ISSUER_GITHUB_AUDIENCE &&
        gh.init.headers.authorization === `Bearer ${SECRETS.requestToken}`,
    );
    const broker = r.calls[1];
    const sent = broker ? JSON.parse(broker.init.body) : {};
    check(
      `proven: ${provider} posts the contract's audience, subject and narrowest ttl to /v1/assertions`,
      broker?.url === `${baseEnv.E2E_ISSUER_URL}/v1/assertions` &&
        sent.provider === provider &&
        sent.audience === contract.audiences[provider] &&
        sent.subject === contract.subject &&
        sent.ttlSeconds === 60 &&
        JSON.stringify(sent.run) === JSON.stringify(run) &&
        broker.init.headers.authorization === `Bearer ${SECRETS.githubToken}`,
    );
    check(`proven: ${provider} never follows a redirect`, r.calls.every((c) => c.init.redirect === "error"));
    check(`proven: ${provider} presents the assertion to the cloud`, r.calls.length >= 3 && r.calls[2].init.body.includes(brokerBody(provider).assertion));
    check(
      `proven: ${provider} writes a WIF config only for gcp`,
      provider === "gcp" ? Object.keys(r.written).length === 1 : Object.keys(r.written).length === 0,
    );
  }
  {
    const r = await runProve("gcp", baseEnv, { broker: brokerBody("gcp") }, { gcpWifConfigOut: "/x/wif.json" });
    const cfg = JSON.parse(r.written["/x/wif.json"] ?? "{}");
    check(
      "gcp: the WIF config names the BROKER pool and the e2e SA",
      cfg.audience === baseEnv.E2E_GCP_BROKER_WIF_AUDIENCE &&
        cfg.service_account_impersonation_url.includes(baseEnv.E2E_GCP_SA_EMAIL) &&
        cfg.subject_token_type === GCP_JWT_TOKEN_TYPE &&
        cfg.type === "external_account" &&
        typeof cfg.credential_source?.file === "string",
    );
    check("gcp: the WIF config carries no secret", leaks(r.written["/x/wif.json"] ?? "").length === 0);
    const sts = JSON.parse(r.calls[2].init.body);
    check("gcp: the STS exchange names the broker pool audience", sts.audience === baseEnv.E2E_GCP_BROKER_WIF_AUDIENCE);
    check(
      "gcp: impersonation carries the FEDERATED token, not the assertion",
      r.calls[3]?.init.headers.authorization === `Bearer ${SECRETS.stsSecret}`,
    );
  }

  // Every claim the console checks, mutated one at a time, must refuse — and name the claim.
  const mutations = [
    ["iss", { iss: "https://evil.example.test" }, {}],
    ["aud", { aud: "sts.aliyuncs.com" }, {}],
    ["sub", { sub: "someone-else" }, {}],
    ["provider", { provider: "gcp" }, {}],
    ["iat", { iat: NOW - 120, exp: NOW - 60 }, {}],
    ["lifetime", { exp: NOW + 600 }, {}],
    ["exp", {}, { expiresAt: new Date((NOW + 61) * 1000).toISOString() }],
    ["repository", { repository: "someone/else" }, {}],
    ["workflow_ref", { workflow_ref: "alethialabs-io/alethialabs/.github/workflows/other.yml@refs/heads/dev" }, {}],
    ["run_id", { run_id: "1" }, {}],
    ["run_attempt", { run_attempt: 1 }, {}],
    ["response issuer", {}, { issuer: "https://evil.example.test" }],
    ["response audience", {}, { audience: "x" }],
    ["response run", {}, { run: { ...run, runId: "1" } }],
  ];
  for (const [claim, claimOver, bodyOver] of mutations) {
    const r = await runProve("aws", baseEnv, { broker: brokerBody("aws", claimOver, bodyOver) });
    check(`claims: a wrong ${claim} is refused`, r.exitCode === EXIT_REFUSED && r.text.includes(claim), r.text);
    check(`claims: a wrong ${claim} never reaches the cloud`, r.calls.length === 2);
  }
  {
    const body = brokerBody("aws");
    body.assertion = `${segment({ alg: "none", kid: "k" })}.${body.assertion.split(".")[1]}.c2ln`;
    const r = await runProve("aws", baseEnv, { broker: body });
    check("claims: an alg other than RS256 is refused", r.exitCode === EXIT_REFUSED && r.text.includes("alg"));
  }

  // Broker refusals name the code and the likely cause, and withhold anything that is not a code.
  {
    const r = await runProve("aws", baseEnv, { brokerStatus: 403, broker: { error: "workflow_not_allowed", requestId: "abc-123" } });
    check(
      "broker: workflow_not_allowed is a refusal that names the code, the hint and this run's ref",
      r.exitCode === EXIT_REFUSED && r.text.includes("workflow_not_allowed") && r.text.includes("dispatch from dev") && r.text.includes(run.workflowRef),
    );
    check("broker: a refusal prints no secret", leaks(r.text).length === 0);
  }
  {
    const r = await runProve("aws", baseEnv, { brokerStatus: 401, broker: { error: "invalid_github_token" } });
    check("broker: invalid_github_token points at the audience variable", r.exitCode === EXIT_REFUSED && r.text.includes("E2E_ISSUER_GITHUB_AUDIENCE"));
  }
  {
    const r = await runProve("aws", baseEnv, { brokerStatus: 500, broker: { error: `<script>${SECRETS.stsSecret}` } });
    check("broker: an error that is not a code is withheld", r.exitCode === EXIT_REFUSED && r.text.includes("<withheld>") && leaks(r.text).length === 0);
  }

  // Cloud refusals say which trust is not applied.
  for (const [provider, scenario, expect] of [
    ["aws", { awsOk: false }, "AccessDenied"],
    ["gcp", { gcpStsOk: false }, "invalid_grant"],
    ["gcp", { gcpSaOk: false }, "PERMISSION_DENIED"],
    ["azure", { azureOk: false }, "AADSTS70021"],
  ]) {
    const r = await runProve(provider, baseEnv, { broker: brokerBody(provider), ...scenario });
    check(`cloud: ${provider} refusal ${expect} is a red that names #4226`, r.exitCode === EXIT_REFUSED && r.text.includes(expect) && r.text.includes("#4226"), r.text);
    check(`cloud: ${provider} refusal prints no secret`, leaks(r.text).length === 0);
  }

  // Inputs that would redirect a bearer token, and invocations that are not this proof.
  for (const [name, over] of [
    ["an issuer with a path", { E2E_ISSUER_URL: "https://e2e-issuer.example.test/x" }],
    ["an http issuer", { E2E_ISSUER_URL: "http://e2e-issuer.example.test" }],
    ["a non-GitHub token endpoint", { ACTIONS_ID_TOKEN_REQUEST_URL: "https://evil.example.test/idtoken" }],
    ["a missing request token", { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" }],
    ["a malformed role ARN", { E2E_AWS_ROLE_ARN: "arn:aws:iam::123:user/x" }],
  ]) {
    const r = await runProve("aws", { ...baseEnv, ...over }, { broker: brokerBody("aws") });
    check(`inputs: ${name} is refused before any call`, r.exitCode === EXIT_REFUSED && r.calls.length === 0, `got ${r.exitCode}`);
  }
  {
    const r = await runProve("alibaba", baseEnv, {});
    check("inputs: alibaba is a usage error citing the ruling", r.exitCode === EXIT_USAGE && r.text.includes("ruling"));
  }
  check("redact: removes every occurrence", redact(`a ${SECRETS.stsSecret} b ${SECRETS.stsSecret}`, [SECRETS.stsSecret]) === "a <redacted> b <redacted>");
  let usage;
  try {
    parseArgs(["prove", "--provider"]);
  } catch (e) {
    usage = e;
  }
  check("args: a flag without a value is a usage error", usage instanceof ProofError && usage.exitCode === EXIT_USAGE);
  const parsed = parseArgs(["prove", "--provider", "gcp", "--gcp-wif-config-out", "/tmp/w.json"]);
  check("args: prove parses provider and WIF path", parsed.provider === "gcp" && parsed.gcpWifConfigOut === "/tmp/w.json");

  if (failures > 0) throw new Error(`${failures} self-test check(s) failed`);
  console.log("self-test: all passed");
}

/** The CLI entry point. Prints only lines prove() built, or a redacted failure. */
async function main(argv) {
  if (argv.includes("--self-test")) {
    await runSelfTest();
    return EXIT_PROVEN;
  }
  const secrets = [process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN];
  try {
    const opts = parseArgs(argv);
    const out = await prove({
      provider: opts.provider,
      env: process.env,
      fetchImpl: fetch,
      contract: loadBrokerContract(),
      nowSeconds: () => Math.floor(Date.now() / 1000),
      gcpWifConfigOut: opts.gcpWifConfigOut,
      writeFile: (p, content) => fs.writeFileSync(p, content, { mode: 0o600 }),
    });
    for (const line of out.lines) console.log(line);
    return out.exitCode;
  } catch (e) {
    const code = e instanceof ProofError ? e.exitCode : EXIT_REFUSED;
    const message = e instanceof ProofError ? e.message : "unexpected failure in the broker proof (details withheld: they may quote a token)";
    console.log(`::error::cli-demo broker proof: ${redact(message, secrets)}`);
    return code;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`self-test failed: ${e.message}`);
      process.exit(1);
    },
  );
}
