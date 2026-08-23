// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `addonCompat` — the adapter the canvas compat surfaces (#1222) render from.
//
// What these pin is mostly the HONESTY of the third state. `not_evaluable` is not an edge case: at
// the time of writing 9 of the 19 catalogued add-ons have no Kubernetes window recorded at all, and
// a design with no cluster yet has no version to judge against. Every one of those must read as
// "we could not check", never as a pass — a UI that quietly rounds unknown up to fine is worse than
// no UI, because it is believed.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { addonCompat } from "@/lib/compat/addon";
import { rangeLabel } from "@/lib/compat";
import { MATRIX } from "@/lib/compat";
import { ADDON_CATALOG } from "@/lib/addons/catalog";

/** Repo root, for the platform-rail manifest check below. */
const REPO_ROOT = resolve(__dirname, "../../../../..");

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

// The two add-on lists must stay ONE set, and until now nothing asserted it.
//
// `MATRIX.addon_k8s` (packages/core/compat/matrix.json) records the Kubernetes window per add-on;
// `ADDON_CATALOG` (apps/console/lib/addons/catalog.ts) is the marketplace. They differ by exactly
// one entry, deliberately — and the test above walks matrix → adapter only, so the *set* relationship
// was unguarded in both directions:
//
//   · an add-on added to the marketplace with no compat window would render `not_evaluable` for
//     every cluster forever, silently, because "no window recorded" is a legitimate state;
//   · an add-on added to the matrix but never to the marketplace would simply never install, and the
//     count guard in tests/lib/addons/catalog-count.test.ts would still pass at its pinned 18.
//
// Neither is hypothetical: the lists were 19/19 until cert-manager moved to the platform rail
// (#1722), and the only thing recording that difference was a comment.
describe("MATRIX.addon_k8s and ADDON_CATALOG are one set", () => {
	/**
	 * Add-ons that are deliberately in the compat matrix but NOT in the marketplace, each mapped to
	 * the platform manifest that installs them instead. An entry here must prove its own premise
	 * (the manifest still exists) — otherwise this becomes the escape hatch that hides the drift it
	 * was written to catch.
	 */
	const PLATFORM_RAIL: Record<string, string> = {
		// #1722: cert-manager needs to see the cloud, the DNS zone and the identity a DNS01
		// ClusterIssuer requires, so it installs from the platform rail rather than the marketplace.
		"cert-manager": "infra/templates/argocd/cert-manager.yaml",
	};

	const matrixIds = Object.keys(MATRIX.addon_k8s);
	const catalogIds = ADDON_CATALOG.map((a) => a.id);

	it("every marketplace add-on has a recorded compat entry", () => {
		const missing = catalogIds.filter((id) => !matrixIds.includes(id));
		// Named, not counted: a bare count tells the next author a number changed, never which one.
		expect(missing, `marketplace add-ons with no MATRIX.addon_k8s entry: ${missing.join(", ")}`).toEqual([]);
	});

	it("every compat entry is either in the marketplace or on the platform rail", () => {
		const orphans = matrixIds.filter((id) => !catalogIds.includes(id) && PLATFORM_RAIL[id] === undefined);
		expect(orphans, `compat entries that nothing installs: ${orphans.join(", ")}`).toEqual([]);
	});

	it("a platform-rail exemption still has its platform manifest", () => {
		// The decay mechanism. If cert-manager ever leaves the platform rail, this fails and forces
		// the exemption to be re-decided rather than quietly outliving its reason.
		for (const [id, manifest] of Object.entries(PLATFORM_RAIL)) {
			expect(existsSync(resolve(REPO_ROOT, manifest)), `${id} is exempted as platform-rail, but ${manifest} does not exist`).toBe(true);
		}
	});

	it("a platform-rail add-on is NOT also in the marketplace", () => {
		// #1722's actual invariant: exactly one thing owns the cert-manager CRDs. Two owners is worse
		// than either alone, and it is what removing it from the catalogue (rather than duplicating
		// it) was for.
		const doubleOwned = Object.keys(PLATFORM_RAIL).filter((id) => catalogIds.includes(id));
		expect(doubleOwned, `installed by BOTH the platform rail and the marketplace: ${doubleOwned.join(", ")}`).toEqual([]);
	});

	it("accounts for every compat entry, so the two counts are explained rather than asserted", () => {
		// Non-vacuity: the three assertions above are all "some list is empty", which would also hold
		// if a list were empty for the wrong reason (a bad import, a renamed export). This pins the
		// partition itself — matrix = marketplace ∪ platform-rail, with no overlap.
		expect(catalogIds.length).toBeGreaterThan(0);
		expect(matrixIds.length).toBe(catalogIds.length + Object.keys(PLATFORM_RAIL).length);
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
