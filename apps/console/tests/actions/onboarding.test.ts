// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the onboarding actions: the rich validation guards on
// configureOnboardingOrg, the completion flag, and the getting-started checklist derivation.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/owner", () => ({ getOwner: vi.fn() }));
vi.mock("@/lib/auth/onboarding", () => ({
	getPrimaryOrg: vi.fn(),
	completeOnboarding: vi.fn(),
}));
vi.mock("@/lib/authz/guard", () => ({ currentActor: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import {
	configureOnboardingOrg,
	getGettingStartedState,
	markOnboardingComplete,
} from "@/app/server/actions/onboarding";
import { getOwner } from "@/lib/auth/owner";
import { completeOnboarding, getPrimaryOrg } from "@/lib/auth/onboarding";
import { currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";

/** A drizzle-ish chain that awaits to `rows`. */
function mockDb(rows: unknown[]) {
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: () => db,
		limit: () => db,
		update: () => db,
		set: () => db,
		then: (resolve: (v: unknown) => void) => resolve(rows),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getOwner).mockResolvedValue("user-1" as never);
	vi.mocked(getPrimaryOrg).mockResolvedValue({ id: "org-1", role: "owner" } as never);
	mockDb([]); // no slug collision by default
});

describe("configureOnboardingOrg — guards", () => {
	const ok = { name: "Acme Cloud", slug: "acme" };

	it("rejects an unauthenticated caller", async () => {
		vi.mocked(getOwner).mockResolvedValue(null as never);
		await expect(configureOnboardingOrg(ok)).rejects.toThrow(/Not authenticated/);
	});

	it("rejects when there's no primary org", async () => {
		vi.mocked(getPrimaryOrg).mockResolvedValue(null as never);
		await expect(configureOnboardingOrg(ok)).rejects.toThrow(/No organization/);
	});

	it("rejects a non-owner", async () => {
		vi.mocked(getPrimaryOrg).mockResolvedValue({ id: "org-1", role: "admin" } as never);
		await expect(configureOnboardingOrg(ok)).rejects.toThrow(/owner/);
	});

	// The four refusals a user can fix are RETURNED, never thrown: a throw out of a "use server"
	// export is redacted to a digest + HTTP 500 in a production build, so the form could never say
	// which one it was (#5415, the #4644 class). Each case below asserted `.rejects.toThrow` before.

	it("refuses a too-short name with a readable reason", async () => {
		expect(await configureOnboardingOrg({ name: "A", slug: "acme" })).toEqual({
			ok: false,
			error: expect.stringMatching(/name/),
		});
	});

	it("refuses an invalid slug with a readable reason", async () => {
		expect(await configureOnboardingOrg({ name: "Acme", slug: "Bad Slug!" })).toEqual({
			ok: false,
			error: expect.stringMatching(/lowercase/),
		});
	});

	it.each(["dashboard", "docs", "DOCS", " docs "])(
		"refuses the reserved slug %j with a readable reason",
		async (slug) => {
			expect(await configureOnboardingOrg({ name: "Acme", slug })).toEqual({
				ok: false,
				error: "That slug is reserved — try another.",
			});
		},
	);

	it("refuses a slug already taken by another org with a readable reason", async () => {
		mockDb([{ id: "other-org" }]); // collision
		expect(await configureOnboardingOrg(ok)).toEqual({
			ok: false,
			error: expect.stringMatching(/taken/),
		});
	});

	it("does not write the org when it refuses", async () => {
		const update = vi.fn();
		const db: Record<string, unknown> = {};
		Object.assign(db, {
			select: () => db,
			from: () => db,
			where: () => db,
			limit: () => db,
			update: (...args: unknown[]) => {
				update(...args);
				return db;
			},
			set: () => db,
			then: (resolve: (v: unknown) => void) => resolve([]),
		});
		vi.mocked(getServiceDb).mockReturnValue(db as never);
		await configureOnboardingOrg({ name: "Acme", slug: "docs" });
		expect(update).not.toHaveBeenCalled();
	});

	it("persists and returns the slug on success", async () => {
		expect(await configureOnboardingOrg(ok)).toEqual({ ok: true, slug: "acme" });
	});
});

describe("markOnboardingComplete", () => {
	it("requires authentication", async () => {
		vi.mocked(getOwner).mockResolvedValue(null as never);
		await expect(markOnboardingComplete()).rejects.toThrow(/Not authenticated/);
	});

	it("marks the user complete", async () => {
		await markOnboardingComplete();
		expect(completeOnboarding).toHaveBeenCalledWith("user-1");
	});
});

describe("getGettingStartedState", () => {
	beforeEach(() => {
		vi.mocked(currentActor).mockResolvedValue({ orgId: "org-1", userId: "user-1", entitlements: undefined } as never);
	});

	it("is all-false with an empty org", async () => {
		mockDb([{ n: 0 }]);
		const s = await getGettingStartedState();
		expect(s).toMatchObject({ hasCloud: false, hasProject: false, hasProvisioned: false });
		expect(s.canInvite).toBe(false); // community entitlements
	});

	it("counts only verified clouds for hasCloud — a pending/failed placeholder doesn't tick it", async () => {
		// The four counts resolve FIFO in query order [clouds, projects, deploys, members]. Zero
		// *verified* clouds → hasCloud false even though projects/deploys exist (a pending placeholder
		// identity, which the query now filters out via is_verified=true, must not tick the step).
		const results: unknown[][] = [[{ n: 0 }], [{ n: 3 }], [{ n: 1 }], [{ n: 1 }]];
		const db: Record<string, unknown> = {};
		Object.assign(db, {
			select: () => db,
			from: () => db,
			where: () => db,
			then: (resolve: (v: unknown) => void) => resolve(results.shift() ?? [{ n: 0 }]),
		});
		vi.mocked(getServiceDb).mockReturnValue(db as never);
		const s = await getGettingStartedState();
		expect(s.hasCloud).toBe(false);
		expect(s.hasProject).toBe(true);
		expect(s.hasProvisioned).toBe(true);
	});

	it("ticks the checklist when resources exist, and gates invite on the plan", async () => {
		mockDb([{ n: 2 }]);
		vi.mocked(currentActor).mockResolvedValue({
			orgId: "org-1",
			userId: "user-1",
			entitlements: { organizations: true },
		} as never);
		const s = await getGettingStartedState();
		expect(s).toMatchObject({ hasCloud: true, hasProject: true, hasProvisioned: true });
		expect(s.canInvite).toBe(true);
		expect(s.memberCount).toBe(2);
	});
});
