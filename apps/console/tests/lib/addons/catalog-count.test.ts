// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Guard test (BYOC proof program, task B0.3) pinning the marketplace add-on set.
//
// WHY the count is pinned: `ADDON_CATALOG` is the single source of truth for the marketplace
// add-ons, and the BYOC proof program's ArgoCD-health assertion (A0.2) derives its expected
// ArgoCD Application set partly from the seeded catalog add-ons. A silent drift in the catalog
// (an add-on quietly appended or removed) would desync that expected set and let A0.2 pass or
// fail vacuously. So changing the catalog must be a DELIBERATE act that also updates this test —
// the failing assertion is the forcing function that says "the ArgoCD expected-set may need
// updating too". We assert the ARRAY LENGTH (a naive `grep 'id:'` counts 22 — nested field
// `id:`s inflate it), never a text grep, by importing the real array.

import { describe, expect, it } from "vitest";
import { ADDON_CATALOG } from "@/lib/addons/catalog";

/** The pinned size of the marketplace add-on catalog. Bump this in lockstep with any
 * deliberate catalog change (and revisit the A0.2 ArgoCD expected-set derivation). */
const EXPECTED_ADDON_COUNT = 19;

describe("ADDON_CATALOG count guard", () => {
	it("has exactly the pinned number of add-ons", () => {
		expect(ADDON_CATALOG.length).toBe(EXPECTED_ADDON_COUNT);
	});

	it("has a unique id per entry (no dup that would corrupt the set at steady length)", () => {
		const ids = ADDON_CATALOG.map((a) => a.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
