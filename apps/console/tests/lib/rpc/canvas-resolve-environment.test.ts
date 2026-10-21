// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6119 review: an environment that does not resolve for the actor (another org's project, a deleted
// environment) is a typed NOT_FOUND on the board's reads, not an internal error. `resolveEnvironment`
// recognises the REAL `resolveActiveEnvironmentId`'s refusal — this drives the real resolver (only
// the database and the actor are stubbed), so a change to its sentence turns this red instead of
// silently turning every such read back into a 500.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
	const rows: { current: unknown[] } = { current: [] };
	return { rows };
});

vi.mock("@/lib/authz/guard", () => ({
	currentActor: vi.fn(async () => ({ userId: "u1", orgId: "org-1" })),
	authorize: vi.fn(async () => ({ userId: "u1", orgId: "org-1" })),
}));
vi.mock("@/lib/db", () => {
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		select: () => chain,
		from: () => chain,
		innerJoin: () => chain,
		where: () => chain,
		limit: () => Promise.resolve(h.rows.current),
	});
	return { getServiceDb: () => chain, withActorScope: vi.fn(), withScope: vi.fn() };
});

const { resolveEnvironment } = await import("@/lib/rpc/procedures/canvas");

beforeEach(() => {
	h.rows.current = [];
});

describe("resolveEnvironment", () => {
	it("answers the environment the resolver finds", async () => {
		h.rows.current = [{ id: "env-1" }];
		await expect(resolveEnvironment("p1", null)).resolves.toBe("env-1");
	});

	it("turns 'no environment for this actor' into a typed NOT_FOUND refusal", async () => {
		await expect(resolveEnvironment("p-foreign", null)).rejects.toMatchObject({
			name: "ActionRefusal",
			kind: "not-found",
		});
	});
});
