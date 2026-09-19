// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The manifest is generated and diff-gated, so what this suite pins is not its CONTENT — that would
// be a second copy of the generator's answer, drifting on its own schedule. It pins the two things a
// consumer depends on and neither the generator nor CI can prove:
//
//   · the committed file satisfies the zod schema the console parses it with (the parse runs at
//     module load, so importing the module IS the assertion);
//   · `knobsFor` withholds every knob a control would lie about — unreachable, provider-owned, or
//     already carried by a typed field.
//
// The third filter is the one worth stating: a knob the canvas ALREADY collects through a typed
// field would, offered again as a generic control, be a second writer of one value — and which one
// wins is a detail of `mergeProviderConfig`'s merge-if-absent rule rather than anything a user could
// predict. The test asserts the withholding directly, because "it happens not to appear today" is
// not the same claim.

import { describe, expect, it } from "vitest";

import { TEMPLATE_KNOBS, knobsFor } from "@/lib/cloud-providers/template-knobs";

describe("the committed manifest", () => {
	it("parses against the schema — importing the module is the assertion", () => {
		expect(TEMPLATE_KNOBS.knobs.length).toBeGreaterThan(200);
		expect(TEMPLATE_KNOBS.clouds).toContain("aws");
		expect(TEMPLATE_KNOBS.clouds).toContain("hetzner");
	});

	it("says it is generated, in its own body", () => {
		// The first thing anyone does with a manifest is edit it.
		expect(TEMPLATE_KNOBS.generatedBy).toMatch(/gen-template-knobs/);
	});

	it("counts every cloud it lists", () => {
		for (const cloud of TEMPLATE_KNOBS.clouds) {
			const counts = TEMPLATE_KNOBS.counts[cloud];
			expect(counts).toBeDefined();
			expect(counts?.declared).toBe(TEMPLATE_KNOBS.knobs.filter((k) => k.cloud === cloud).length);
		}
	});

	it("names a component and a declaration site on every knob", () => {
		for (const knob of TEMPLATE_KNOBS.knobs) {
			expect(knob.component).not.toBe("");
			expect(knob.declaredAt).toMatch(/^infra\/templates\/project\/.+:\d+$/);
		}
	});
});

describe("knobsFor", () => {
	it("offers something for a component whose passthrough is root-shaped", () => {
		// The cluster is merged at root level on every cloud, so this is the cell most likely to be
		// non-empty — and an empty answer here would mean the filters are inverted rather than strict.
		expect(knobsFor("aws", "cluster").length).toBeGreaterThan(0);
	});

	it("withholds a knob no passthrough reaches", () => {
		const unreachable = TEMPLATE_KNOBS.knobs.find((k) => !k.reachable);
		expect(unreachable).toBeDefined();
		if (!unreachable) return;
		expect(knobsFor(unreachable.cloud, "cluster").some((k) => k.name === unreachable.name && !unreachable.reachable)).toBe(false);
		// And the general form: nothing `knobsFor` returns is unreachable, on any cell.
		for (const cloud of TEMPLATE_KNOBS.clouds) {
			for (const kind of ["cluster", "database", "cache", "dns", "registry", "bucket", "queue"] as const) {
				expect(knobsFor(cloud, kind).every((k) => k.reachable)).toBe(true);
			}
		}
	});

	it("withholds a knob the provider owns or a typed field already carries", () => {
		for (const cloud of TEMPLATE_KNOBS.clouds) {
			for (const kind of ["cluster", "database", "cache", "dns", "registry", "bucket", "queue"] as const) {
				for (const knob of knobsFor(cloud, kind)) {
					expect(knob.ownedByProvider).toBe(false);
					expect(knob.typed).toBe(false);
				}
			}
		}
		// Both states must actually OCCUR in the manifest, or the assertions above pass vacuously —
		// a filter proves nothing against a surface with nothing to filter.
		expect(TEMPLATE_KNOBS.knobs.some((k) => k.ownedByProvider)).toBe(true);
		expect(TEMPLATE_KNOBS.knobs.some((k) => k.typed)).toBe(true);
	});

	it("never offers a `platform` knob to a component card", () => {
		// `region`, `project_name` and the `alethia_*` namespace are the environment's identity, frozen
		// by the runner. A component card that could edit them could rename the environment it is in.
		for (const cloud of TEMPLATE_KNOBS.clouds) {
			for (const kind of ["cluster", "database", "bucket"] as const) {
				expect(knobsFor(cloud, kind).every((k) => k.component === kind)).toBe(true);
			}
		}
		expect(TEMPLATE_KNOBS.knobs.some((k) => k.component === "platform")).toBe(true);
	});

	it("returns an empty list for a cloud it has never heard of, rather than throwing", () => {
		expect(knobsFor("not-a-cloud", "cluster")).toEqual([]);
	});

	it("sorts by name so a card's controls do not reorder when the generator's file order changes", () => {
		const names = knobsFor("aws", "cluster").map((k) => k.name);
		expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
	});

	it("carries an itemScope on a knob that lands inside one entry of a map/list variable", () => {
		// A bucket's `provider_config` merges into ONE ENTRY of `bucket_configuration`, never onto a
		// root variable — the distinction #4259 renamed a Go helper to preserve.
		const scoped = TEMPLATE_KNOBS.knobs.filter((k) => k.itemScope !== undefined);
		expect(scoped.length).toBeGreaterThan(0);
		for (const knob of scoped) expect(knob.reachable).toBe(true);
	});
});
