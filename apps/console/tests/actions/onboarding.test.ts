// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
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

	it("rejects a too-short name", async () => {
		await expect(configureOnboardingOrg({ name: "A", slug: "acme" })).rejects.toThrow(/name/);
	});

	it("rejects an invalid slug", async () => {
		await expect(configureOnboardingOrg({ name: "Acme", slug: "Bad Slug!" })).rejects.toThrow(/lowercase/);
	});

	it("rejects a reserved slug", async () => {
		await expect(configureOnboardingOrg({ name: "Acme", slug: "dashboard" })).rejects.toThrow(/reserved/);
	});

	it("rejects a slug already taken by another org", async () => {
		mockDb([{ id: "other-org" }]); // collision
		await expect(configureOnboardingOrg(ok)).rejects.toThrow(/taken/);
	});

	it("persists and returns the slug on success", async () => {
		expect(await configureOnboardingOrg(ok)).toEqual({ slug: "acme" });
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
