// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for lib/auth/onboarding.ts. The only boundaries stubbed are the
// service DB (a thenable drizzle-ish chain whose terminal awaits drain a results queue) and
// the PDP/OpenFGA owner-grant mirror. The pure slug helpers (lib/routing) and the real
// drizzle schema are kept REAL so the slug-collision + handle-precedence branches exercise
// the actual logic. Asserts: idempotency short-circuit, handle precedence + slug uniqueness,
// the org/member insert payloads, the grant call, getPrimaryOrg's row mapping + null coerce,
// and the onboarding read/write branches.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/authz/grants", () => ({ ensureMemberGrant: vi.fn() }));

import { ensureMemberGrant } from "@/lib/authz/grants";
import {
	completeOnboarding,
	getPrimaryOrg,
	isOnboardingComplete,
	provisionPrimaryOrg,
} from "@/lib/auth/onboarding";
import { getServiceDb } from "@/lib/db";
import { member, organization, user } from "@/lib/db/schema";

/**
 * Builds a thenable drizzle-ish db: every builder method returns the chain, and each
 * `await` (the chain is thenable) shifts the next value off `results`. Records the
 * insert targets, .values() / .set() payloads, and what columns .select() was called with.
 */
function makeDb(results: unknown[]) {
	const queue = [...results];
	const calls = {
		insertTargets: [] as unknown[],
		updateTargets: [] as unknown[],
		values: [] as unknown[],
		set: [] as unknown[],
		selects: [] as unknown[],
	};
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		select: (cols?: unknown) => {
			calls.selects.push(cols);
			return chain;
		},
		from: () => chain,
		innerJoin: () => chain,
		where: () => chain,
		orderBy: () => chain,
		limit: () => chain,
		insert: (t: unknown) => {
			calls.insertTargets.push(t);
			return chain;
		},
		update: (t: unknown) => {
			calls.updateTargets.push(t);
			return chain;
		},
		set: (v: unknown) => {
			calls.set.push(v);
			return chain;
		},
		values: (v: unknown) => {
			calls.values.push(v);
			return chain;
		},
		returning: () => chain,
		then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
			Promise.resolve(queue.shift()).then(resolve, reject),
	});
	vi.mocked(getServiceDb).mockReturnValue(chain as never);
	return calls;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(ensureMemberGrant).mockResolvedValue(undefined as never);
});

describe("provisionPrimaryOrg", () => {
	it("is a no-op when the user already has a membership", async () => {
		const calls = makeDb([[{ id: "m-1" }]]); // existingMember non-empty
		await provisionPrimaryOrg({ id: "u-1", email: "bob@x.com", username: "bob" });

		expect(calls.insertTargets).toHaveLength(0);
		expect(ensureMemberGrant).not.toHaveBeenCalled();
	});

	it("provisions an org named after the username, owner member, and owner grant", async () => {
		const calls = makeDb([
			[], // existingMember: none
			[], // taken slugs: none
			[{ id: "org-1" }], // organization insert returning
			undefined, // member insert (void)
		]);

		await provisionPrimaryOrg({ id: "u-1", email: "bob@x.com", username: "bob" });

		// org insert first, then member insert, both against the real schema tables.
		expect(calls.insertTargets[0]).toBe(organization);
		expect(calls.insertTargets[1]).toBe(member);
		expect(calls.values[0]).toEqual({ name: "bob's Org", slug: "bob" });
		expect(calls.values[1]).toEqual({
			organizationId: "org-1",
			userId: "u-1",
			role: "owner",
			status: "active",
		});
		expect(ensureMemberGrant).toHaveBeenCalledWith("org-1", "u-1", "owner");
	});

	it("disambiguates the slug against already-taken org slugs (pickFreeSlug)", async () => {
		const calls = makeDb([
			[], // no existing membership
			[{ slug: "bob" }], // "bob" already taken
			[{ id: "org-2" }],
			undefined,
		]);

		await provisionPrimaryOrg({ id: "u-2", email: "x@x.com", username: "bob" });

		expect(calls.values[0]).toEqual({ name: "bob's Org", slug: "bob-2" });
	});

	it("avoids reserved slugs (e.g. docs) via RESERVED_SLUGS", async () => {
		const calls = makeDb([[], [], [{ id: "org-3" }], undefined]);
		await provisionPrimaryOrg({ id: "u-3", email: "x@x.com", username: "docs" });
		expect(calls.values[0]).toEqual({ name: "docs's Org", slug: "docs-2" });
	});

	it("falls back to display name, then email local-part, then 'user' for the handle", async () => {
		// name only
		let calls = makeDb([[], [], [{ id: "o" }], undefined]);
		await provisionPrimaryOrg({ id: "u", email: "x@x.com", name: "Ada Lovelace" });
		expect(calls.values[0]).toEqual({ name: "Ada Lovelace's Org", slug: "ada-lovelace" });

		// email local-part only
		calls = makeDb([[], [], [{ id: "o" }], undefined]);
		await provisionPrimaryOrg({ id: "u", email: "carol@x.com" });
		expect(calls.values[0]).toEqual({ name: "carol's Org", slug: "carol" });

		// nothing usable → "user"
		calls = makeDb([[], [], [{ id: "o" }], undefined]);
		await provisionPrimaryOrg({ id: "u", email: "@x.com" });
		expect(calls.values[0]).toEqual({ name: "user's Org", slug: "user" });
	});

	it("bails (no member insert, no grant) when the org insert returns nothing", async () => {
		const calls = makeDb([
			[], // no membership
			[], // no taken slugs
			[], // org insert returning [] → undefined org
		]);

		await provisionPrimaryOrg({ id: "u-4", email: "x@x.com", username: "bob" });

		expect(calls.insertTargets).toEqual([organization]); // only the org insert attempted
		expect(calls.values).toHaveLength(1);
		expect(ensureMemberGrant).not.toHaveBeenCalled();
	});
});

describe("getPrimaryOrg", () => {
	it("maps the joined row into the PrimaryOrg shape", async () => {
		makeDb([
			[
				{
					id: "org-1",
					name: "Bob's Org",
					slug: "bob",
					logo: "logo.png",
					role: "owner",
				},
			],
		]);

		const r = await getPrimaryOrg("u-1");
		expect(r).toEqual({
			id: "org-1",
			name: "Bob's Org",
			slug: "bob",
			logo: "logo.png",
			role: "owner",
		});
	});

	it("coerces a null slug to an empty string", async () => {
		makeDb([[{ id: "o", name: "n", slug: null, logo: null, role: "member" }]]);
		const r = await getPrimaryOrg("u-1");
		expect(r?.slug).toBe("");
		expect(r?.logo).toBeNull();
	});

	it("returns null when the user has no membership", async () => {
		makeDb([[]]);
		expect(await getPrimaryOrg("nobody")).toBeNull();
	});
});

describe("isOnboardingComplete", () => {
	it("is true when onboarding_completed_at is set", async () => {
		makeDb([[{ at: new Date("2026-01-01T00:00:00Z") }]]);
		expect(await isOnboardingComplete("u-1")).toBe(true);
	});

	it("is false when onboarding_completed_at is null", async () => {
		makeDb([[{ at: null }]]);
		expect(await isOnboardingComplete("u-1")).toBe(false);
	});

	it("is false when the user row is missing", async () => {
		makeDb([[]]);
		expect(await isOnboardingComplete("ghost")).toBe(false);
	});
});

describe("completeOnboarding", () => {
	it("updates the user row, setting onboarding_completed_at to a Date", async () => {
		const calls = makeDb([undefined]);
		await completeOnboarding("u-1");

		expect(calls.updateTargets).toEqual([user]);
		expect(calls.set).toHaveLength(1);
		const payload = calls.set[0] as { onboardingCompletedAt: unknown };
		expect(payload.onboardingCompletedAt).toBeInstanceOf(Date);
	});
});
