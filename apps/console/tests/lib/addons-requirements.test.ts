// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the provider-aware add-on requirement hints: every requirement used in
// the catalog resolves to a hint, and every resolver returns a non-empty label + hint for
// all provisioning clouds (and the null "no provider yet" case).

import { describe, expect, it } from "vitest";
import { ADDON_CATALOG } from "@/lib/addons/catalog";
import { REQUIREMENT_HINTS } from "@/lib/addons/requirements";
import type { RequirementSatisfaction } from "@/lib/addons/requirements";
import type { AddOnRequirement } from "@/lib/addons/types";
import type { CloudProviderSlug } from "@/lib/cloud-providers/generated/catalog";

const ALL_PROVIDERS: (CloudProviderSlug | null)[] = [
	"aws",
	"gcp",
	"azure",
	"alibaba",
	"hetzner",
	null,
];

const SATISFACTIONS: RequirementSatisfaction[] = ["built-in", "addon", "manual"];

describe("REQUIREMENT_HINTS", () => {
	it("covers every requirement declared anywhere in the catalog", () => {
		const used = new Set<AddOnRequirement>();
		for (const a of ADDON_CATALOG) {
			for (const r of a.requires ?? []) used.add(r);
		}
		expect(used.size).toBeGreaterThan(0);
		for (const r of used) {
			expect(typeof REQUIREMENT_HINTS[r]).toBe("function");
		}
	});

	it("returns a non-empty label + hint + valid satisfaction for all providers and null", () => {
		for (const [req, resolve] of Object.entries(REQUIREMENT_HINTS)) {
			for (const provider of ALL_PROVIDERS) {
				const h = resolve(provider);
				expect(h.label.length, `${req}/${provider}`).toBeGreaterThan(0);
				expect(h.hint.length, `${req}/${provider}`).toBeGreaterThan(0);
				expect(SATISFACTIONS).toContain(h.satisfied);
			}
		}
	});

	it("names each cloud's default StorageClass (ground truth from the tofu templates)", () => {
		expect(REQUIREMENT_HINTS.storage("aws").hint).toContain("gp3");
		expect(REQUIREMENT_HINTS.storage("gcp").hint).toContain("standard-rwo");
		expect(REQUIREMENT_HINTS.storage("azure").hint).toContain("managed-csi");
		expect(REQUIREMENT_HINTS.storage("alibaba").hint).toContain(
			"alicloud-disk",
		);
		expect(REQUIREMENT_HINTS.storage("hetzner").hint).toContain(
			"hcloud-volumes",
		);
		// Alibaba's template manages no StorageClass — the user must verify the default.
		expect(REQUIREMENT_HINTS.storage("alibaba").satisfied).toBe("manual");
		expect(REQUIREMENT_HINTS.storage(null).hint).toContain(
			"default StorageClass",
		);
	});

	it("points the domain hint at the provider's DNS service", () => {
		expect(REQUIREMENT_HINTS.domain("aws").hint).toContain("Route 53");
		expect(REQUIREMENT_HINTS.domain("hetzner").hint).toContain("ExternalDNS");
		expect(REQUIREMENT_HINTS.domain(null).satisfied).toBe("manual");
	});
});
