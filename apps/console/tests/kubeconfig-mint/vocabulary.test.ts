// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The kubeconfig mint's fixed vocabularies (#5281): which tier needs which action, which clouds mint
// which shapes, and which failure sentences may be stored.

import { describe, expect, it } from "vitest";
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

describe("the fixed failure reasons", () => {
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
