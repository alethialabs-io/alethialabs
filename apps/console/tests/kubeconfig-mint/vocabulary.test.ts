// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The kubeconfig mint's fixed vocabularies (#5281): which tier needs which action, which clouds mint
// which shapes, and which failure sentences may be stored.

import { describe, expect, it } from "vitest";
import {
	isMintableCloud,
	isSharedClusterPlacement,
	KUBECONFIG_MINT_SHARED_CLUSTER_REASON,
} from "@/lib/clusters/mint-eligibility";
import { actionForTier, mintShapeRefusal } from "@/lib/kubeconfig-mint/clouds";
import {
	fixedFailureReason,
	KUBECONFIG_MINT_FAILURE_REASONS,
	KUBECONFIG_MINT_UNKNOWN_FAILURE,
} from "@/lib/kubeconfig-mint/reasons";
import { kubeconfigMintFailureReason } from "@/lib/validations/cli-contract";

describe("actionForTier", () => {
	it("maps each tier to exactly its own action", () => {
		expect(actionForTier("readonly")).toBe("access_readonly");
		expect(actionForTier("admin")).toBe("access_admin");
	});
});

describe("mintShapeRefusal", () => {
	it.each(["aws", "gcp", "azure"] as const)("%s mints both shapes", (p) => {
		expect(mintShapeRefusal(p, "exec")).toBeNull();
		expect(mintShapeRefusal(p, "static")).toBeNull();
	});

	it.each(["hetzner", "alibaba"] as const)("%s mints a static certificate only", (p) => {
		expect(mintShapeRefusal(p, "exec")).toBe("static-only");
		expect(mintShapeRefusal(p, "static")).toBeNull();
	});

	it.each(["digitalocean", "civo", null] as const)("%s has no minter", (p) => {
		expect(mintShapeRefusal(p, "static")).toBe("unsupported-cloud");
	});
});

describe("isMintableCloud", () => {
	it("agrees with mintShapeRefusal on every cloud, and refuses a name it does not know", () => {
		for (const p of ["aws", "gcp", "azure", "alibaba", "hetzner", "digitalocean", "civo"] as const) {
			expect(isMintableCloud(p)).toBe(mintShapeRefusal(p, "static") === null);
		}
		expect(isMintableCloud(null)).toBe(false);
		expect(isMintableCloud("AWS")).toBe(false);
	});
});

describe("isSharedClusterPlacement", () => {
	it("is namespace and vcluster, exactly — every other value, typed or not, is not shared", () => {
		expect(isSharedClusterPlacement("namespace")).toBe(true);
		expect(isSharedClusterPlacement("vcluster")).toBe(true);
		for (const v of ["dedicated", "Namespace", "", null, undefined, 0, { value: "namespace" }]) {
			expect(isSharedClusterPlacement(v)).toBe(false);
		}
	});
});

describe("the fixed failure reasons", () => {
	it("the shared-cluster sentence the request route answers is the one in the list (#5327)", () => {
		// The list keeps it as a literal for the runner's parity test; the constant must be that literal.
		expect(KUBECONFIG_MINT_FAILURE_REASONS).toContain(KUBECONFIG_MINT_SHARED_CLUSTER_REASON);
		expect(KUBECONFIG_MINT_SHARED_CLUSTER_REASON).toBe(
			"Kubeconfig mints are not available for an environment placed on a shared cluster.",
		);
	});

	it("every sentence fits the wire contract's bound, and the generic one is in the set", () => {
		expect(KUBECONFIG_MINT_FAILURE_REASONS).toContain(KUBECONFIG_MINT_UNKNOWN_FAILURE);
		for (const r of KUBECONFIG_MINT_FAILURE_REASONS) {
			expect(kubeconfigMintFailureReason.safeParse(r).success).toBe(true);
		}
		expect(new Set(KUBECONFIG_MINT_FAILURE_REASONS).size).toBe(KUBECONFIG_MINT_FAILURE_REASONS.length);
	});

	it("keeps a known sentence and replaces anything else, by exact match only", () => {
		const known = KUBECONFIG_MINT_FAILURE_REASONS[2];
		expect(fixedFailureReason(known)).toBe(known);
		expect(fixedFailureReason(`${known} `)).toBe(KUBECONFIG_MINT_UNKNOWN_FAILURE);
		expect(fixedFailureReason(known.toLowerCase())).toBe(KUBECONFIG_MINT_UNKNOWN_FAILURE);
		expect(fixedFailureReason("token=abc")).toBe(KUBECONFIG_MINT_UNKNOWN_FAILURE);
	});
});
