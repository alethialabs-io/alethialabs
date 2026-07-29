// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `addonCompat` — the adapter the canvas compat surfaces (#1222) render from.
//
// What these pin is mostly the HONESTY of the third state. `not_evaluable` is not an edge case: at
// the time of writing 9 of the 19 catalogued add-ons have no Kubernetes window recorded at all, and
// a design with no cluster yet has no version to judge against. Every one of those must read as
// "we could not check", never as a pass — a UI that quietly rounds unknown up to fine is worse than
// no UI, because it is believed.

import { describe, expect, it } from "vitest";
import { addonCompat } from "@/lib/compat/addon";
import { rangeLabel } from "@/lib/compat";
import { MATRIX } from "@/lib/compat";

describe("addonCompat", () => {
	it("passes when the cluster is inside the recorded window", () => {
		// kyverno is 1.25+ in the matrix.
		const c = addonCompat("kyverno", "1.35");
		expect(c.status).toBe("pass");
		expect(c.window).toBe("1.25+");
	});

	it("fails below the lower bound, and says what is required vs what is there", () => {
		const c = addonCompat("kyverno", "1.24");
		expect(c.status).toBe("fail");
		expect(c.note).toContain("1.25+");
		expect(c.note).toContain("1.24");
	});

	it("ignores the patch level", () => {
		expect(addonCompat("kyverno", "1.25.6").status).toBe("pass");
		expect(addonCompat("kyverno", "v1.25").status).toBe("pass");
	});

	it("is not_evaluable when NO window is recorded — never a pass", () => {
		// falco has both bounds empty. This is the majority case in the catalogue.
		const c = addonCompat("falco", "1.35");
		expect(c.status).toBe("not_evaluable");
		expect(c.note).toMatch(/no kubernetes compatibility range recorded/i);
	});

	it("is not_evaluable when the cluster version is unset — never a pass", () => {
		// A design with no cluster yet, or a cluster whose version hasn't been chosen.
		const c = addonCompat("kyverno", undefined);
		expect(c.status).toBe("not_evaluable");
		expect(c.note).toMatch(/unset or unparseable/i);
	});

	it("is not_evaluable for an add-on absent from the matrix", () => {
		const c = addonCompat("not-a-real-addon", "1.35");
		expect(c.status).toBe("not_evaluable");
	});

	it("never reports pass without both a recorded window AND a cluster version", () => {
		// The property behind all of the above, asserted over the whole catalogue.
		for (const [id, range] of Object.entries(MATRIX.addon_k8s)) {
			const unknownCluster = addonCompat(id, undefined);
			expect(unknownCluster.status).not.toBe("pass");
			if (!range.k8s_min && !range.k8s_max) {
				expect(addonCompat(id, "1.35").status).toBe("not_evaluable");
			}
		}
	});
});

describe("rangeLabel — the string the chip shows", () => {
	it("renders each window shape", () => {
		expect(rangeLabel("1.25", "")).toBe("1.25+");
		expect(rangeLabel("", "1.32")).toBe("≤1.32");
		expect(rangeLabel("1.34", "1.36")).toBe("1.34–1.36");
		expect(rangeLabel("", "")).toBe("any");
	});
});
