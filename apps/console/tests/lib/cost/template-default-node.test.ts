// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// TEMPLATE_DEFAULT_NODE restates, by hand, what each cloud's project template buys for a cluster
// with no instance types (#5251). Nothing generates it, so this test is the only thing that notices
// when a template moves: it reads each named `variables.tf` and fails if the default there is not
// the one the cost estimate prices. It ranges over the TABLE, and separately requires the table to
// cover every provisioning cloud, so a cloud cannot be dropped from both at once and pass.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CLOUD_PROVIDER_SLUGS } from "@/lib/cloud-providers/provider-slug";
import { INSTANCE_TYPES } from "@/lib/cloud-providers";
import { TEMPLATE_DEFAULT_NODE } from "@/lib/cost/template-default-node";

const REPO_ROOT = resolve(__dirname, "../../../../..");

/** The `default = …` of `variable "<name>"` in a .tf file, as the first quoted string in it. */
function tfDefault(file: string, variable: string): string | null {
	const src = readFileSync(resolve(REPO_ROOT, file), "utf8");
	const start = src.indexOf(`variable "${variable}"`);
	if (start < 0) return null;
	// The block ends at the first line that is exactly "}" — variables.tf blocks are top level.
	const end = src.indexOf("\n}", start);
	const block = src.slice(start, end < 0 ? undefined : end);
	const m = block.match(/^\s*default\s*=\s*\[?\s*"([^"]+)"/m);
	return m?.[1] ?? null;
}

describe("TEMPLATE_DEFAULT_NODE matches the templates it restates", () => {
	it("covers every provisioning cloud", () => {
		expect(Object.keys(TEMPLATE_DEFAULT_NODE).sort()).toEqual([...CLOUD_PROVIDER_SLUGS].sort());
	});

	it.each(Object.entries(TEMPLATE_DEFAULT_NODE))(
		"%s: the template's variables.tf default is the node the estimate prices",
		(_provider, node) => {
			const found = tfDefault(node.source.file, node.source.variable);
			expect(found, `${node.source.file}: variable "${node.source.variable}" has no readable default`).not.toBeNull();
			expect(found).toBe(node.instanceType);
		},
	);

	it("hetzner: the provider's hard-coded fallback is the same node", () => {
		// hetzner_provider.go does not leave an empty list to the template: it substitutes its own
		// literal, so that is the default that actually provisions and it must agree too.
		const go = readFileSync(resolve(REPO_ROOT, "packages/core/cloud/hetzner_provider.go"), "utf8");
		const m = go.match(/workerType := "([^"]+)"/);
		expect(m?.[1]).toBe(TEMPLATE_DEFAULT_NODE.hetzner.instanceType);
	});

	it.each(Object.entries(TEMPLATE_DEFAULT_NODE).filter(([p]) => p !== "aws"))(
		"%s: the fallback rate is the catalog's monthly cost hint for that node",
		(provider, node) => {
			// Non-AWS rates have no live price table, so they come from the catalog's own hint. A hint
			// that changes there must change here, or the two surfaces quote different numbers.
			const slug = CLOUD_PROVIDER_SLUGS.find((s) => s === provider);
			if (!slug) throw new Error(`unknown provider ${provider}`);
			const offered = INSTANCE_TYPES[slug].find((i) => i.value === node.instanceType);
			// Every non-AWS template default is in the picker's list today; if one leaves it, there
			// is no hint left to agree with and the rate needs a new stated source — so fail.
			const hint = offered?.cost.match(/(\d+(?:\.\d+)?)/)?.[1];
			expect(hint, `${node.instanceType} has no cost hint in INSTANCE_TYPES.${slug}`).toBeDefined();
			expect(node.fallbackHourly).toBeCloseTo(Number(hint) / 730, 6);
		},
	);
});
