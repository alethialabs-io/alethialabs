// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  cliCloudIdentitiesResponse,
  cliClusterDetailResponse,
  cliClustersPageResponse,
  cliJobLogsResponse,
  cliJobResponse,
  cliJobsPageResponse,
  cliPageInfo,
  cliRepositoriesResponse,
  cliLatestReleaseWire,
  cliReleasePublishWire,
  cliByoChartAttachResponse,
  cliByoScanResponse,
  cliRunnerRegistrationResponse,
  cliDesignApplyResponse,
  cliDestroyTreeResponse,
  cliRunnersResponse,
  cliSigningKeysResponse,
  cliUsageResponse,
  connectIdentityWire,
  deployRunnerWire,
  initIdentityWire,
  jobWire,
  providerStatusWire,
  cliKubeconfigMintRequest,
  cliKubeconfigMintResponse,
  cliKubeconfigMintPollResponse,
  kubeconfigMintCredential,
  kubeconfigMintRequestInsert,
  runnerKubeconfigMintResult,
  runnerKubeconfigMintSpec,
} from "@/lib/validations/cli-contract";
import { componentSchemaWire } from "@/lib/cli/project-components";

// The CLI wire fixtures live next to the Go contract test (packages/core/api/
// testdata) and are decoded there into the Go structs the CLI uses. This suite
// is the other half of the guard: it asserts every fixture still satisfies the
// Zod contract. So when the DB schema (and thus the contract) changes, a stale
// fixture fails here — and once regenerated, the new fixture fails the Go strict
// decode until the Go struct is updated. Neither side can drift silently.
const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/core/api/testdata",
);

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
}

const cases: ReadonlyArray<[string, z.ZodType]> = [
  ["runners.json", cliRunnersResponse],
  ["byo_attach.json", cliByoChartAttachResponse],
  ["byo_scan.json", cliByoScanResponse],
  ["runner_registration.json", cliRunnerRegistrationResponse],
  ["design_apply.json", cliDesignApplyResponse],
  ["clusters_page.json", cliClustersPageResponse],
  ["cluster_detail.json", cliClusterDetailResponse],
  ["cloud_identities.json", cliCloudIdentitiesResponse],
  ["jobs_page.json", cliJobsPageResponse],
  // The paging vocabulary's own fixture. It was registered in the contract by #3666 and
  // never listed here, so it carried `"limit": 0` against `pageInfoSchema`'s `.positive()`
  // for as long as it existed — the Go side strict-decodes it, which checks the SHAPE and
  // says nothing about whether the value is one the schema allows.
  ["page_info.json", cliPageInfo],
  ["job.json", jobWire],
  ["job_logs.json", cliJobLogsResponse],
  ["repositories.json", cliRepositoriesResponse],
  ["provider_status.json", providerStatusWire],
  ["deploy_runner.json", deployRunnerWire],
  ["latest_release.json", cliLatestReleaseWire],
  ["job_response.json", cliJobResponse],
  // #5249: the destroy tree `alethia project destroy --cascade` prints before it confirms.
  ["destroy_tree.json", cliDestroyTreeResponse],
  ["init_identity.json", initIdentityWire],
  ["connect_identity.json", connectIdentityWire],
  ["usage.json", cliUsageResponse],
  ["signing_keys.json", cliSigningKeysResponse],
  // The published component registry (#3671). The fixture is dumped from componentSchemaDocument()
  // itself, so it is the bytes the route ships; the Go side (components_schema_test.go) reads the
  // same file, and the manifest reader validates alethia.yaml against what it decodes.
  ["component_schema.json", componentSchemaWire],
  // #5280: the short-lived kubeconfig mint channel. The Go side strict-decodes the same files into
  // packages/core/types/kubeconfig_mint.go (packages/core/api/contract_test.go).
  ["kubeconfig_mint_request.json", cliKubeconfigMintRequest],
  ["kubeconfig_mint_response.json", cliKubeconfigMintResponse],
  ["kubeconfig_mint_poll.json", cliKubeconfigMintPollResponse],
  ["runner_kubeconfig_mint_spec.json", runnerKubeconfigMintSpec],
  ["runner_kubeconfig_mint_result.json", runnerKubeconfigMintResult],
  ["kubeconfig_mint_credential.json", kubeconfigMintCredential],
];

describe("CLI wire contract ↔ fixtures", () => {
  it.each(cases)("%s conforms to its contract schema", (file, schema) => {
    const result = schema.safeParse(loadFixture(file));
    if (!result.success) {
      throw new Error(
        `${file} violates its CLI wire contract:\n${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });
});

describe("CLI release publication contract", () => {
  it("accepts stable, attributable release metadata", () => {
    expect(
      cliReleasePublishWire.safeParse({
        version: "1.2.3",
        release_notes: "Notes",
        released_at: "2026-08-31T05:37:26Z",
        github_release_url:
          "https://github.com/alethialabs-io/alethia-cli/releases/tag/v1.2.3",
        commit_sha: "a".repeat(40),
      }).success,
    ).toBe(true);
  });

  it("rejects aliases and unattributable commits", () => {
    expect(
      cliReleasePublishWire.safeParse({
        version: "latest",
        release_notes: "Notes",
        released_at: "today",
        github_release_url: "not-a-url",
        commit_sha: "short",
      }).success,
    ).toBe(false);
  });
});

// #5280 — the kubeconfig mint contract. Values are written out, never derived from the schema under
// test: the bounds ARE the decisions (#5250 §2: default 1h, max 8h, read-only by default).
describe("kubeconfig mint contract", () => {
  const KEY = "Qw9LmFlmUUWmsbonQCRIe9ZvA6LdV313U8aNfX0AwAw"; // 32 bytes, base64url, unpadded
  const SEALED = "A".repeat(66);
  const ID = "00000000-0000-4000-8000-000000000001";

  it("defaults a request to read-only for one hour", () => {
    const parsed = cliKubeconfigMintRequest.parse({ shape: "exec", client_public_key: KEY });
    expect(parsed.tier).toBe("readonly");
    expect(parsed.ttl_seconds).toBe(3600);
  });

  it("caps the TTL at 8h and floors it at 15m", () => {
    const at = (ttl: number) =>
      cliKubeconfigMintRequest.safeParse({ shape: "static", client_public_key: KEY, ttl_seconds: ttl }).success;
    expect(at(28_800)).toBe(true);
    expect(at(28_801)).toBe(false);
    expect(at(900)).toBe(true);
    expect(at(899)).toBe(false);
    expect(at(3600.5)).toBe(false);
  });

  it("refuses a request that tries to name the cluster's identity itself (mint-bind)", () => {
    expect(
      cliKubeconfigMintRequest.safeParse({
        shape: "exec",
        client_public_key: KEY,
        server: "https://attacker.example",
      }).success,
    ).toBe(false);
  });

  it("refuses an unknown tier and a malformed client key", () => {
    expect(cliKubeconfigMintRequest.safeParse({ shape: "exec", client_public_key: KEY, tier: "root" }).success).toBe(false);
    // padded base64 (44 chars with '='), standard alphabet, and a 31-byte key are all refused
    for (const bad of [`${KEY}=`, KEY.replace(/-/g, "+").replace(/_/g, "/").slice(0, 42) + "+", KEY.slice(0, 42)]) {
      expect({ key: bad, ok: cliKubeconfigMintRequest.safeParse({ shape: "exec", client_public_key: bad }).success }).toEqual({
        key: bad,
        ok: false,
      });
    }
  });

  it("accepts every poll state, and `ready` only with a sealed blob", () => {
    const ok = (v: unknown) => cliKubeconfigMintPollResponse.safeParse(v).success;
    expect(ok({ status: "pending", private_endpoint: null, expires_at: "2026-01-01T00:00:00.000Z" })).toBe(true);
    expect(ok({ status: "ready", private_endpoint: true, sealed: SEALED })).toBe(true);
    expect(ok({ status: "failed", private_endpoint: null, reason: "cluster unreachable" })).toBe(true);
    expect(ok({ status: "expired", private_endpoint: false })).toBe(true);
    expect(ok({ status: "ready", private_endpoint: true })).toBe(false);
    expect(ok({ status: "ready", private_endpoint: true, sealed: "A".repeat(65) })).toBe(false);
    expect(ok({ status: "consumed", private_endpoint: null })).toBe(false);
  });

  it("refuses a runner result that carries anything beside the ciphertext", () => {
    const ready = { status: "ready", mint_id: ID, sealed: SEALED, private_endpoint: false };
    expect(runnerKubeconfigMintResult.safeParse(ready).success).toBe(true);
    expect(runnerKubeconfigMintResult.safeParse({ ...ready, kubeconfig: "apiVersion: v1" }).success).toBe(false);
    expect(runnerKubeconfigMintResult.safeParse({ ...ready, token: "t" }).success).toBe(false);
    expect(
      runnerKubeconfigMintResult.safeParse({ status: "failed", mint_id: ID, reason: "x".repeat(501), private_endpoint: null })
        .success,
    ).toBe(false);
  });

  it("shapes the sealed plaintext as exec or static, never both", () => {
    const exec = {
      shape: "exec",
      tier: "admin",
      server: "https://203.0.113.10:6443",
      certificate_authority_data: "Q0EtREFUQQ==",
      token: "t",
      expires_at: "2026-01-01T00:00:00.000Z",
    };
    expect(kubeconfigMintCredential.safeParse(exec).success).toBe(true);
    expect(kubeconfigMintCredential.safeParse({ ...exec, kubeconfig: "apiVersion: v1" }).success).toBe(false);
    expect(
      kubeconfigMintCredential.safeParse({
        shape: "static",
        tier: "readonly",
        kubeconfig: "apiVersion: v1",
        expires_at: "2026-01-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("derives the row insert from the table and leaves the runner's columns out of it", () => {
    const row = {
      org_id: ID,
      cluster_id: ID,
      job_id: ID,
      actor_user_id: ID,
      tier: "readonly",
      ttl_seconds: 3600,
      shape: "exec",
      client_public_key: KEY,
      expires_at: new Date("2026-01-01T00:10:00.000Z"),
    };
    expect(kubeconfigMintRequestInsert.safeParse(row).success).toBe(true);
    expect(kubeconfigMintRequestInsert.safeParse({ ...row, ttl_seconds: 28_801 }).success).toBe(false);
    const withSealed = kubeconfigMintRequestInsert.safeParse({ ...row, sealed_result: SEALED });
    expect(withSealed.success && "sealed_result" in withSealed.data).toBe(false);
  });
});
