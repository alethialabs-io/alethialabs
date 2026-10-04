// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The CLI org routes (`/api/cli/orgs/:id/{members,teams}`) through the REAL guard (#5479).
//
// The caller is signed in with no `X-Alethia-Org` header, so `authorizeCli` resolves their PERSONAL
// scope, where they hold everything. The path names org B, where they hold only what each test
// gives them. Before #5479 the guard checked the route's permission in the personal scope and only
// a member row in B, so every write below that expects a 403 came back 2xx.
//
// Mocked: the CLI token, the scope resolver (answers the org it is asked for), the PDP (a policy
// table keyed on org), and the database. The guard, the routes and the role ceiling are real.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/cli/auth", () => ({
	verifyCliToken: vi.fn(async () => ({ payload: { sub: CALLER } })),
}));
vi.mock("@/lib/auth/scope", () => ({
	getActiveScope: vi.fn(async (userId: string, orgId?: string) => ({
		userId,
		orgId: orgId ?? userId,
	})),
}));
vi.mock("@/lib/authz/grants", () => ({ revokeMemberGrant: vi.fn() }));

const { CALLER, ORG_B, held, db } = vi.hoisted(() => ({
	CALLER: "11111111-1111-4111-8111-111111111111",
	ORG_B: "22222222-2222-4222-8222-222222222222",
	/** The permission keys the caller holds in ORG_B. Their personal org holds everything. */
	held: new Set<string>(),
	db: {
		limit: vi.fn(),
		insertValues: vi.fn<(v: { role?: string | null }) => void>(),
		returning: vi.fn(),
		deleteWhere: vi.fn(),
	},
}));

vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		select: () => ({ from: () => ({ where: () => ({ limit: db.limit }) }) }),
		insert: () => ({
			values: (v: { role?: string | null }) => {
				db.insertValues(v);
				return { returning: db.returning };
			},
		}),
		delete: () => ({ where: db.deleteWhere }),
	}),
}));

vi.mock("@/lib/authz", async () => {
	const { ForbiddenError } = await import("@/lib/authz/types");
	type Action = import("@/lib/authz/registry").Action;
	type Resource = import("@/lib/authz/registry").Resource;
	const allowed = (a: { userId: string; orgId: string }, action: string, type: string) =>
		a.orgId === a.userId || (a.orgId === ORG_B && held.has(`${type}:${action}`));
	return {
		getPdp: () => ({
			can: async (a: { userId: string; orgId: string }, action: string, r: { type: string }) => ({
				allowed: allowed(a, action, r.type),
			}),
			enforce: async (
				a: { userId: string; orgId: string },
				action: Action,
				r: { type: Resource; id?: string },
			) => {
				if (!allowed(a, action, r.type)) throw new ForbiddenError(action, r, "denied");
			},
		}),
	};
});

import { DELETE as memberDelete } from "@/app/api/cli/orgs/[id]/members/[memberId]/route";
import { POST as membersPost } from "@/app/api/cli/orgs/[id]/members/route";
import { DELETE as teamDelete } from "@/app/api/cli/orgs/[id]/teams/[teamId]/route";
import { POST as teamsPost } from "@/app/api/cli/orgs/[id]/teams/route";
import { BUILT_IN_ROLES } from "@/lib/authz/registry";

const MEMBER_ID = "33333333-3333-4333-8333-333333333333";
const TEAM_ID = "44444444-4444-4444-8444-444444444444";

/** A JSON request to the route. */
function req(body?: unknown): Request {
	return new Request("http://localhost/api/cli/orgs", {
		method: "POST",
		headers: { authorization: "Bearer t", "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

/** Gives the caller a built-in role's permission keys in ORG_B. */
function holdRole(role: "admin" | "viewer") {
	const keys = BUILT_IN_ROLES[role];
	if (keys === "*") throw new Error("not used for owner");
	for (const k of keys) held.add(k);
}

beforeEach(() => {
	vi.clearAllMocks();
	held.clear();
	// An ACTIVE member row in ORG_B exists for the caller; the same read serves the routes' own
	// member/team lookups.
	db.limit.mockResolvedValue([{ id: TEAM_ID, userId: "u-target", role: "viewer" }]);
	db.returning.mockImplementation(async () => [
		{
			id: "55555555-5555-4555-8555-555555555555",
			email: "new@example.test",
			name: "t",
			role: db.insertValues.mock.calls.at(-1)?.[0]?.role ?? null,
			status: "pending",
		},
	]);
	db.deleteWhere.mockResolvedValue(undefined);
});

const orgParams = { params: Promise.resolve({ id: ORG_B }) };

describe("a member of org B without manage_members there (#5479)", () => {
	beforeEach(() => holdRole("viewer"));

	it("cannot invite", async () => {
		const res = await membersPost(req({ email: "x@example.test", role: "viewer" }), orgParams);
		expect(res.status).toBe(403);
		expect(db.insertValues).not.toHaveBeenCalled();
	});

	it("cannot remove a member", async () => {
		const res = await memberDelete(req(), {
			params: Promise.resolve({ id: ORG_B, memberId: MEMBER_ID }),
		});
		expect(res.status).toBe(403);
		expect(db.deleteWhere).not.toHaveBeenCalled();
	});

	it("cannot create a team", async () => {
		const res = await teamsPost(req({ name: "t" }), orgParams);
		expect(res.status).toBe(403);
		expect(db.insertValues).not.toHaveBeenCalled();
	});

	it("cannot delete a team", async () => {
		const res = await teamDelete(req(), {
			params: Promise.resolve({ id: ORG_B, teamId: TEAM_ID }),
		});
		expect(res.status).toBe(403);
		expect(db.deleteWhere).not.toHaveBeenCalled();
	});
});

describe("an admin of org B", () => {
	beforeEach(() => holdRole("admin"));

	it("invites into org B (the control)", async () => {
		const res = await membersPost(req({ email: "x@example.test", role: "admin" }), orgParams);
		expect(res.status).toBe(201);
		expect(db.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: ORG_B, role: "admin", inviterId: CALLER }),
		);
	});

	it("creates and deletes a team in org B (the control)", async () => {
		expect((await teamsPost(req({ name: "t" }), orgParams)).status).toBe(201);
		expect(
			(await teamDelete(req(), { params: Promise.resolve({ id: ORG_B, teamId: TEAM_ID }) }))
				.status,
		).toBe(200);
	});

	it("cannot invite an owner", async () => {
		const res = await membersPost(req({ email: "x@example.test", role: "owner" }), orgParams);
		expect(res.status).toBe(400);
		expect(db.insertValues).not.toHaveBeenCalled();
	});

	it("cannot smuggle an owner in through a comma-joined role", async () => {
		const res = await membersPost(
			req({ email: "x@example.test", role: "viewer,owner" }),
			orgParams,
		);
		expect(res.status).toBe(400);
		expect(db.insertValues).not.toHaveBeenCalled();
	});

	it("cannot invite a role the console does not offer", async () => {
		const res = await membersPost(
			req({ email: "x@example.test", role: "superuser" }),
			orgParams,
		);
		expect(res.status).toBe(400);
		expect(db.insertValues).not.toHaveBeenCalled();
	});

	// The CLI's own `--role` default. Better Auth's `member` is our `viewer`, stored as `viewer`.
	it("accepts the CLI default `member` and stores it as viewer", async () => {
		const res = await membersPost(req({ email: "x@example.test", role: "member" }), orgParams);
		expect(res.status).toBe(201);
		expect(db.insertValues).toHaveBeenCalledWith(expect.objectContaining({ role: "viewer" }));
	});
});

describe("the invite ceiling", () => {
	// manage_members without the rest of admin's bundle: may invite, but not into admin.
	it("refuses inviting a role that grants more than the inviter holds in org B", async () => {
		held.add("member:manage_members");
		held.add("member:view");
		const res = await membersPost(req({ email: "x@example.test", role: "admin" }), orgParams);
		expect(res.status).toBe(403);
		expect(db.insertValues).not.toHaveBeenCalled();
	});
});
