// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { decide } from "@/lib/authz/evaluate";

// S is a project under org O (ancestors of S = [O]).
describe("decide (allow ∧ ¬deny — explicit deny overrides)", () => {
	it("allows when an allow covers and no deny", () => {
		expect(decide([null], [], "S", ["O"])).toBe(true); // org-wide allow
		expect(decide(["O"], [], "S", ["O"])).toBe(true); // org allow inherits to project
		expect(decide(["S"], [], "S", ["O"])).toBe(true); // direct allow on the project
	});

	it("explicit deny on the resource overrides an inherited allow (the headline case)", () => {
		// "view the org's projects, EXCEPT project S": allow at O, deny at S.
		expect(decide(["O"], ["S"], "S", ["O"])).toBe(false);
		// a sibling project S2 (also under O) is unaffected.
		expect(decide(["O"], ["S"], "S2", ["O"])).toBe(true);
	});

	it("container deny excludes all descendants", () => {
		// allow org-wide, deny across org O ⇒ project S (under O) denied.
		expect(decide([null], ["O"], "S", ["O"])).toBe(false);
	});

	it("a deny elsewhere does not affect this resource", () => {
		expect(decide([null], ["OTHER"], "S", ["O"])).toBe(true);
	});

	it("no allow ⇒ denied (default-deny)", () => {
		expect(decide([], ["S"], "S", ["O"])).toBe(false);
		expect(decide([], [], "S", ["O"])).toBe(false);
	});
});
