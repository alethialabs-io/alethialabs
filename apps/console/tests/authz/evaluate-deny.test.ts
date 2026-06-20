// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { decide } from "@/lib/authz/evaluate";

// S is a spec under zone Z (ancestors of S = [Z, org]).
describe("decide (allow ∧ ¬deny — explicit deny overrides)", () => {
	it("allows when an allow covers and no deny", () => {
		expect(decide([null], [], "S", ["Z"])).toBe(true); // org-wide allow
		expect(decide(["Z"], [], "S", ["Z"])).toBe(true); // zone allow inherits to spec
		expect(decide(["S"], [], "S", ["Z"])).toBe(true); // direct allow on the spec
	});

	it("explicit deny on the resource overrides an inherited allow (the headline case)", () => {
		// "view this zone's specs, EXCEPT spec S": allow at Z, deny at S.
		expect(decide(["Z"], ["S"], "S", ["Z"])).toBe(false);
		// a sibling spec S2 (also under Z) is unaffected.
		expect(decide(["Z"], ["S"], "S2", ["Z"])).toBe(true);
	});

	it("container deny excludes all descendants", () => {
		// allow org-wide, deny across zone Z ⇒ spec S (under Z) denied.
		expect(decide([null], ["Z"], "S", ["Z"])).toBe(false);
	});

	it("a deny elsewhere does not affect this resource", () => {
		expect(decide([null], ["OTHER"], "S", ["Z"])).toBe(true);
	});

	it("no allow ⇒ denied (default-deny)", () => {
		expect(decide([], ["S"], "S", ["Z"])).toBe(false);
		expect(decide([], [], "S", ["Z"])).toBe(false);
	});
});
