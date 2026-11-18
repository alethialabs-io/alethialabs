// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The one catalogue of what can be added to a board (#6764). Every surface that offers an add reads
// it, so these pin what it lists for a cloud, a set of flags and a governed environment.

import { describe, expect, it, vi } from "vitest";

// No cloud refuses a kind today, so "the catalogue narrows with the cloud" has nothing real to
// narrow on. One cloud is made to refuse one kind here, through the single source the registry
// reads, so the narrowing is exercised rather than assumed.
vi.mock("@/lib/cloud-providers/unsupported-kinds", () => {
	const refused: Record<string, readonly string[]> = { hetzner: ["topic"] };
	return {
		UNSUPPORTED_KINDS_BY_PROVIDER: refused,
		unsupportedKindsFor: (provider: string | null) => (provider ? (refused[provider] ?? []) : []),
	};
});

import {
	addableKindsFor,
	ROADMAP_ITEMS,
} from "@/components/design-project/canvas/graph/node-registry";
import { addCatalogue, catalogueKinds } from "@/lib/canvas/store/add-catalogue";

const NO_FLAGS = { byoHelm: false, byoIac: false };

/** The ids of every row of one type. */
function rowIds(groups: ReturnType<typeof addCatalogue>, type: string): string[] {
	return groups.flatMap((g) => g.rows.filter((r) => r.type === type).map((r) => r.id));
}

describe("addCatalogue", () => {
	it("offers exactly the kinds the cloud can build", () => {
		for (const provider of ["aws", "hetzner", null] as const) {
			const kinds = catalogueKinds(addCatalogue(provider, NO_FLAGS, false));
			expect([...kinds].sort()).toEqual([...addableKindsFor(provider)].sort());
		}
	});

	it("narrows with the cloud: one that cannot build a kind does not offer it", () => {
		expect(catalogueKinds(addCatalogue("aws", NO_FLAGS, false))).toContain("topic");
		expect(catalogueKinds(addCatalogue(null, NO_FLAGS, false))).toContain("topic");
		const refusing = catalogueKinds(addCatalogue("hetzner", NO_FLAGS, false));
		expect(refusing).not.toContain("topic");
		expect(refusing).toContain("queue");
	});

	it("lists each kind once, under a heading, with a label and its singleton rule", () => {
		const groups = addCatalogue("aws", NO_FLAGS, false);
		const kinds = catalogueKinds(groups);
		expect(new Set(kinds).size).toBe(kinds.length);
		const rows = groups.flatMap((g) => g.rows);
		expect(rows.every((r) => r.label.length > 0)).toBe(true);
		const dns = rows.find((r) => r.type === "kind" && r.kind === "dns");
		const database = rows.find((r) => r.type === "kind" && r.kind === "database");
		expect(dns?.type === "kind" ? dns.singleton : null).toBe(true);
		expect(database?.type === "kind" ? database.singleton : null).toBe(false);
	});

	it("shows the roadmap rows, which are not pickable kinds", () => {
		const groups = addCatalogue("aws", NO_FLAGS, false);
		expect(rowIds(groups, "roadmap")).toEqual(ROADMAP_ITEMS.map((item) => item.id));
		expect(catalogueKinds(groups)).not.toContain("volume");
	});

	it("offers bring-your-own chart and IaC only when their flags are on", () => {
		expect(rowIds(addCatalogue("aws", NO_FLAGS, false), "source")).toEqual([]);
		expect(rowIds(addCatalogue("aws", { byoHelm: true, byoIac: false }, false), "source")).toEqual([
			"byo-chart",
		]);
		const both = addCatalogue("aws", { byoHelm: true, byoIac: true }, false);
		expect(rowIds(both, "source")).toEqual(["byo-chart", "byo-iac"]);
		expect(both.at(-1)?.title).toBe("Sources");
	});

	it("lists the add-ons it is given, under their own heading", () => {
		const groups = addCatalogue(
			"aws",
			{ ...NO_FLAGS, addons: [{ id: "grafana", name: "Grafana", subtitle: "Dashboards" }] },
			false,
		);
		const addons = groups.find((g) => g.title === "Add-ons");
		expect(addons?.rows).toEqual([
			{ type: "addon", id: "grafana", label: "Grafana", subtitle: "Dashboards" },
		]);
	});

	it("returns no group with nothing in it", () => {
		const groups = addCatalogue("aws", NO_FLAGS, false);
		expect(groups.every((g) => g.rows.length > 0)).toBe(true);
		expect(groups.map((g) => g.title)).not.toContain("Sources");
		expect(groups.map((g) => g.title)).not.toContain("Add-ons");
	});

	it("is empty while a bring-your-own IaC module governs the environment", () => {
		expect(addCatalogue("aws", { byoHelm: true, byoIac: true }, true)).toEqual([]);
	});
});
