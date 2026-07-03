// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { getEntitlements } from "@/lib/authz/entitlements";
import type { Actor, Entitlements } from "@/lib/authz/types";
import { COMMUNITY_ENTITLEMENTS, planEntitlements } from "@/lib/billing/plan";

/** A minimal actor carrying only the field the accessor reads. */
function actor(entitlements?: Entitlements): Actor {
	return { userId: "u1", orgId: "o1", entitlements } as unknown as Actor;
}

describe("getEntitlements", () => {
	it("returns the actor's resolved entitlements when present", () => {
		const team = planEntitlements("team");
		expect(getEntitlements(actor(team))).toBe(team);
	});

	it("falls back to the community baseline when unresolved", () => {
		expect(getEntitlements(actor(undefined))).toBe(COMMUNITY_ENTITLEMENTS);
	});
});
