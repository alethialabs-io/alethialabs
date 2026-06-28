// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the C2 slug-resolution actions: stub getOwnerScope + a thenable
// drizzle chain (getServiceDb for org reads, withOwnerScope for tenant-scoped reads) and the
// workspace setActiveOrganization side-effect, then assert the personal-scope branch, the
// membership/404 throws, the active-org sync, and the returned shapes.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/owner", () => ({ getOwnerScope: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn(), withOwnerScope: vi.fn() }));
vi.mock("@/app/server/actions/workspace", () => ({
	setActiveOrganization: vi.fn(),
}));

import {
	getActiveOrgSlug,
	getEnvironmentsForSlug,
	getProjectSlug,
	resolveEnvironmentId,
	resolveOrgScope,
	resolveProjectId,
} from "@/app/server/actions/resolve";
import { getOwnerScope } from "@/lib/auth/owner";
import { getServiceDb, withOwnerScope } from "@/lib/db";
import { setActiveOrganization } from "@/app/server/actions/workspace";

/**
 * A drizzle-ish chain whose every builder returns itself and which awaits to the next queued
 * result. `.limit()` / `.orderBy()` are terminal, so we pop one seeded result per terminal await.
 */
function makeChain(results: unknown[][]) {
	const queue = [...results];
	const chain: Record<string, unknown> = {};
	const passthrough = () => chain;
	Object.assign(chain, {
		select: passthrough,
		from: passthrough,
		innerJoin: passthrough,
		leftJoin: passthrough,
		where: passthrough,
		limit: passthrough,
		orderBy: passthrough,
		then: (resolve: (v: unknown) => void) => resolve(queue.shift() ?? []),
	});
	return chain;
}

/** Stub getServiceDb with a chain seeded with the given terminal results (in await order). */
function mockServiceDb(...results: unknown[][]) {
	vi.mocked(getServiceDb).mockReturnValue(makeChain(results) as never);
}

/** Stub withOwnerScope so it invokes its callback with a tx chain seeded with results. */
function mockOwnerScope(...results: unknown[][]) {
	vi.mocked(withOwnerScope).mockImplementation(
		(async (_userId: string, cb: (tx: unknown) => unknown) =>
			cb(makeChain(results))) as never,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getOwnerScope).mockResolvedValue({
		userId: "user-1",
		activeOrgId: "user-1",
	} as never);
});

describe("resolveOrgScope", () => {
	it("returns the personal scope for `~` without touching the org table", async () => {
		const r = await resolveOrgScope("~");
		expect(r).toEqual({ orgId: "user-1", isPersonal: true });
		expect(getServiceDb).not.toHaveBeenCalled();
		// activeOrgId already === userId → no clearing needed.
		expect(setActiveOrganization).not.toHaveBeenCalled();
	});

	it("clears a stale active org when switching to personal", async () => {
		vi.mocked(getOwnerScope).mockResolvedValue({
			userId: "user-1",
			activeOrgId: "org-9",
		} as never);
		const r = await resolveOrgScope("~");
		expect(r).toEqual({ orgId: "user-1", isPersonal: true });
		expect(setActiveOrganization).toHaveBeenCalledWith("user-1");
	});

	it("resolves a real slug for a member and syncs the active org", async () => {
		mockServiceDb([{ id: "org-1" }]);
		const r = await resolveOrgScope("acme");
		expect(r).toEqual({ orgId: "org-1", isPersonal: false });
		// activeOrgId was "user-1" ≠ org-1 → sync.
		expect(setActiveOrganization).toHaveBeenCalledWith("org-1");
	});

	it("does not re-sync when the slug already matches the active org", async () => {
		vi.mocked(getOwnerScope).mockResolvedValue({
			userId: "user-1",
			activeOrgId: "org-1",
		} as never);
		mockServiceDb([{ id: "org-1" }]);
		const r = await resolveOrgScope("acme");
		expect(r).toEqual({ orgId: "org-1", isPersonal: false });
		expect(setActiveOrganization).not.toHaveBeenCalled();
	});

	it("throws when the slug doesn't resolve to a member org", async () => {
		mockServiceDb([]); // no org/membership row
		await expect(resolveOrgScope("ghost")).rejects.toThrow(/Organization not found/);
		expect(setActiveOrganization).not.toHaveBeenCalled();
	});
});

describe("resolveProjectId", () => {
	it("returns the project id for a resolvable slug", async () => {
		mockOwnerScope([{ id: "proj-1" }]);
		await expect(resolveProjectId("api")).resolves.toBe("proj-1");
		expect(withOwnerScope).toHaveBeenCalledWith("user-1", expect.any(Function));
	});

	it("throws when the project slug doesn't resolve", async () => {
		mockOwnerScope([]);
		await expect(resolveProjectId("nope")).rejects.toThrow(/Project not found/);
	});
});

describe("resolveEnvironmentId", () => {
	it("returns the environment id for a resolvable name", async () => {
		mockOwnerScope([{ id: "env-1" }]);
		await expect(resolveEnvironmentId("proj-1", "staging")).resolves.toBe("env-1");
	});

	it("throws when the environment doesn't resolve", async () => {
		mockOwnerScope([]);
		await expect(resolveEnvironmentId("proj-1", "ghost")).rejects.toThrow(
			/Environment not found/,
		);
	});
});

describe("getActiveOrgSlug", () => {
	it("returns the slug of the explicitly selected active org", async () => {
		vi.mocked(getOwnerScope).mockResolvedValue({
			userId: "user-1",
			activeOrgId: "org-1",
		} as never);
		mockServiceDb([{ slug: "acme" }]);
		await expect(getActiveOrgSlug()).resolves.toBe("acme");
	});

	it("falls back to the earliest membership when no org is selected", async () => {
		// activeOrgId === userId (personal) → skips the first lookup, uses primary query.
		mockServiceDb([{ slug: "primary-org" }]);
		await expect(getActiveOrgSlug()).resolves.toBe("primary-org");
	});

	it("falls back to the primary membership when the selected org row is missing", async () => {
		vi.mocked(getOwnerScope).mockResolvedValue({
			userId: "user-1",
			activeOrgId: "org-gone",
		} as never);
		// First lookup (by activeOrgId) returns nothing → second (primary) returns a row.
		mockServiceDb([], [{ slug: "primary-org" }]);
		await expect(getActiveOrgSlug()).resolves.toBe("primary-org");
	});

	it("returns the personal slug when the user has no memberships", async () => {
		mockServiceDb([]); // no primary membership
		await expect(getActiveOrgSlug()).resolves.toBe("~");
	});
});

describe("getProjectSlug", () => {
	it("returns the slug for a known project id", async () => {
		mockOwnerScope([{ projectSlug: "api" }]);
		await expect(getProjectSlug("proj-1")).resolves.toBe("api");
	});

	it("returns null when the project id isn't in scope", async () => {
		mockOwnerScope([]);
		await expect(getProjectSlug("proj-x")).resolves.toBeNull();
	});
});

describe("getEnvironmentsForSlug", () => {
	it("returns [] when the project slug doesn't resolve", async () => {
		mockOwnerScope([]); // project lookup empty
		await expect(getEnvironmentsForSlug("nope")).resolves.toEqual([]);
	});

	it("lists the project's environments when the slug resolves", async () => {
		const envs = [
			{ id: "env-1", name: "staging", stage: "staging", is_default: true },
			{ id: "env-2", name: "prod", stage: "production", is_default: false },
		];
		// First terminal await = project lookup; second = env list.
		mockOwnerScope([{ id: "proj-1" }], envs);
		await expect(getEnvironmentsForSlug("api")).resolves.toEqual(envs);
	});
});
