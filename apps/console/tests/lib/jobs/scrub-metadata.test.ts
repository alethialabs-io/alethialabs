// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Security regression (SOC 2 CC6.7): the console must scrub runner-posted execution_metadata
// at ITS OWN trust boundary — the runner-side scrub (output_scrub.go) cannot be relied on
// because legacy / mid-rollout / self-registered runners post whatever they want and
// update_job_status jsonb-merges the blob verbatim. These tests plant a credential sentinel
// at every nesting shape and assert scrubExecutionMetadata drops it, while the legitimate
// raw-plan subtree (plan_result) and non-secret keys survive untouched.

import { describe, expect, it } from "vitest";
import {
	isSensitiveMetadataKey,
	scrubExecutionMetadata,
} from "@/lib/jobs/scrub-metadata";

/** A value unlikely to occur by accident — a surviving occurrence means a real leak. */
const SENTINEL = "SENTINEL-CRED-1e7a4d0c-DO-NOT-PERSIST";

describe("scrubExecutionMetadata", () => {
	it("drops the historical argocd_admin_password top-level key (the P0 leak shape)", () => {
		const meta: Record<string, unknown> = {
			cluster_name: "prod-eks",
			argocd_url: "https://argocd.example.com",
			argocd_admin_password: SENTINEL,
		};
		const dropped = scrubExecutionMetadata(meta);
		expect(dropped).toEqual(["argocd_admin_password"]);
		expect(JSON.stringify(meta)).not.toContain(SENTINEL);
		// Non-secrets survive.
		expect(meta).toMatchObject({
			cluster_name: "prod-eks",
			argocd_url: "https://argocd.example.com",
		});
	});

	it("drops credential-named keys nested in objects and array elements", () => {
		const meta: Record<string, unknown> = {
			outputs: {
				kubeconfig: `apiVersion: v1\n# ${SENTINEL}`,
				api_token: SENTINEL,
				eks_cluster_endpoint: "https://abc.eks.amazonaws.com",
				custom_secret_arns: { "db-pass": "arn:aws:secretsmanager:...:db-pass" },
			},
			infra_services: [{ service: "argocd", admin_password: SENTINEL }],
		};
		const dropped = scrubExecutionMetadata(meta);
		expect(dropped).toEqual(
			expect.arrayContaining([
				"outputs.kubeconfig",
				"outputs.api_token",
				"infra_services[0].admin_password",
			]),
		);
		expect(dropped).toHaveLength(3);
		expect(JSON.stringify(meta)).not.toContain(SENTINEL);
		// Non-secret nested keys survive (incl. the non-value-bearing secret HANDLES).
		expect(meta).toMatchObject({
			outputs: {
				eks_cluster_endpoint: "https://abc.eks.amazonaws.com",
				custom_secret_arns: { "db-pass": "arn:aws:secretsmanager:...:db-pass" },
			},
			infra_services: [{ service: "argocd" }],
		});
	});

	it("does NOT descend into plan_result (raw tofu plan attribute keys legitimately collide)", () => {
		// A PLAN job's resource_changes carry attribute maps whose KEYS are named password/
		// master_password/… — plan-time unknowns or sensitive-marked, rendered verbatim by
		// lib/plan/parse-plan.ts. Key-scrubbing them would corrupt the Plan tab.
		const meta: Record<string, unknown> = {
			plan_completed: true,
			plan_result: {
				resource_changes: [
					{
						address: "aws_db_instance.main",
						change: {
							after: { engine: "postgres", password: true },
							after_unknown: { master_password: true },
						},
					},
				],
			},
		};
		const dropped = scrubExecutionMetadata(meta);
		expect(dropped).toEqual([]);
		// The plan payload is untouched.
		expect(meta.plan_result).toMatchObject({
			resource_changes: [
				{ change: { after: { password: true } } },
			],
		});
	});

	it("still drops a top-level secret on a PLAN-shaped post (opaqueness is per-subtree, not per-job)", () => {
		// A malicious/legacy runner posting the password alongside plan_result must not slip
		// through — the exemption stops recursion INTO plan_result, nothing else.
		const meta: Record<string, unknown> = {
			plan_result: { resource_changes: [] },
			argocd_admin_password: SENTINEL,
		};
		expect(scrubExecutionMetadata(meta)).toEqual(["argocd_admin_password"]);
		expect(JSON.stringify(meta)).not.toContain(SENTINEL);
	});

	it("the opaque exemption applies at the top level only (a nested plan_result is descended)", () => {
		const meta: Record<string, unknown> = {
			outputs: { plan_result: { admin_password: SENTINEL } },
		};
		expect(scrubExecutionMetadata(meta)).toEqual([
			"outputs.plan_result.admin_password",
		]);
	});

	it("is a no-op on non-object input (null / string / array)", () => {
		expect(scrubExecutionMetadata(null)).toEqual([]);
		expect(scrubExecutionMetadata(undefined)).toEqual([]);
		expect(scrubExecutionMetadata("password=x")).toEqual([]);
		expect(scrubExecutionMetadata([{ password: SENTINEL }])).toEqual([]);
	});

	it("keeps legitimate structured-report keys (verify/addon/drift shapes carry no denylist hits)", () => {
		// Verified against the Go json tags (packages/core/{verify,argocd,drift}) — key_id,
		// signature, sealed-secrets addon names etc. must never be false-positives.
		const meta: Record<string, unknown> = {
			verify_receipt: { key_id: "k1", signature: "sig", algorithm: "ed25519" },
			addon_status: { "addon-sealed-secrets": { health: "Healthy", sync: "Synced" } },
			drift_posture: { in_sync: true, drifted: 0, details: [] },
		};
		expect(scrubExecutionMetadata(meta)).toEqual([]);
		expect(meta.verify_receipt).toMatchObject({ key_id: "k1", signature: "sig" });
	});
});

describe("isSensitiveMetadataKey", () => {
	it("matches the runner denylist semantics (case-insensitive substring)", () => {
		for (const hit of [
			"argocd_admin_password",
			"KUBECONFIG",
			"gke_kubeconfig",
			"kube_config_raw",
			"talosconfig",
			"admin_client_key",
			"custom_secret_values",
			"aws_access_key",
			"api_token",
			"bootstrap_manifests",
		]) {
			expect({ key: hit, sensitive: isSensitiveMetadataKey(hit) }).toEqual({
				key: hit,
				sensitive: true,
			});
		}
		for (const miss of [
			"argocd_url",
			"cluster_endpoint",
			"custom_secret_arns",
			"custom_secret_names",
			"rds_master_credentials_secret_arn",
			"key_id",
			"tokenizer", // "_token" requires the underscore — bare "token" substrings don't match
		]) {
			expect({ key: miss, sensitive: isSensitiveMetadataKey(miss) }).toEqual({
				key: miss,
				sensitive: false,
			});
		}
	});
});
