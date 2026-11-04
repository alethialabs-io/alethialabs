// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// `promotionInActorOrg` asks the PDP with the check its action calls for: `view` is a read the
// Environments overview repeats on every live refresh, so it uses `authorizeRead` (quiet on allow,
// recorded on refusal); `deploy` is a write and keeps `authorize`, which records the allow too.
//
// Mocked boundary: the guard and the service-role lookup (which answers one promotion of the actor's
// org). What the lookup's predicate does against real Postgres is tests/integration/org-bound-decisions.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
	authorize: vi.fn(),
	authorizeRead: vi.fn(),
	currentActor: vi.fn(),
}));
vi.mock("@/lib/authz/guard", () => ({
	authorize: h.authorize,
	authorizeRead: h.authorizeRead,
	currentActor: h.currentActor,
}));
vi.mock("@/lib/db", () => {
	const chain = {
		select: () => chain,
		from: () => chain,
		innerJoin: () => chain,
		where: () => chain,
		limit: async () => [{ promotion: { id: "promo-1", project_id: "p1" }, orgId: "org-1" }],
	};
	return { getServiceDb: () => chain };
});

import { promotionInActorOrg } from "@/lib/promotions/org-binding";

const ACTOR = { userId: "u1", orgId: "org-1", credential: "session" };

beforeEach(() => {
	vi.clearAllMocks();
	h.currentActor.mockResolvedValue(ACTOR);
	h.authorize.mockResolvedValue(ACTOR);
	h.authorizeRead.mockResolvedValue(ACTOR);
});

describe("promotionInActorOrg asks the check its action calls for", () => {
	it("view uses the read check, never the recording one", async () => {
		const out = await promotionInActorOrg("promo-1", "view");
		expect(out.promotion.project_id).toBe("p1");
		expect(h.authorizeRead).toHaveBeenCalledWith("view", { type: "project", id: "p1" });
		expect(h.authorize).not.toHaveBeenCalled();
	});

	it("deploy keeps the recording check", async () => {
		await promotionInActorOrg("promo-1", "deploy");
		expect(h.authorize).toHaveBeenCalledWith("deploy", { type: "project", id: "p1" });
		expect(h.authorizeRead).not.toHaveBeenCalled();
	});
});
