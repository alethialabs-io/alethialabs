// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The auth route's member guards on better-auth's organization endpoints (#5472). better-auth
// authorizes member management from `member.role` alone and counts suspended owners as owners, so:
//   - a SUSPENDED admin could invite a second account they control, which `afterAcceptInvitation`
//     then granted as an ACTIVE admin;
//   - the last ACTIVE owner could leave while a suspended owner remained;
//   - a member who left kept their grants, since leave fires no organization hook.
// better-auth is replaced by a handler spy, so "refused" means the request never reached it.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { invitation, member, ssoProvider } from "@/lib/db/schema";

/** The signed-in caller the session read answers with; null means no session. */
type Caller = { userId: string; activeOrgId?: string } | null;

const h = vi.hoisted(() => {
	/** The default caller: a member whose session's active org is `org-active`. */
	function signedIn(): Caller {
		return { userId: "user-1", activeOrgId: "org-active" };
	}
	return {
		signedIn,
		post: vi.fn(async (_req: Request) => new Response("post-handler")),
		caller: signedIn(),
		lookupFails: false,
		byTable: new Map<unknown, unknown[]>(),
		memberByOrg: new Map<string, unknown[]>(),
		removalOwnerRefusal: vi.fn(
			async (_org: string, _member: string): Promise<string | null> => null,
		),
		revokeMemberGrant: vi.fn(async (_org: string, _user: string) => undefined),
		cancelPendingInvitationsFrom: vi.fn(
			async (_db: unknown, _org: string, _user: string) => undefined,
		),
	};
});

vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/auth/trusted-ip", () => ({ trustedIpFailure: () => null }));
vi.mock("@/lib/authz/entitlements", () => ({ getEntitlements: () => ({ organizations: true }) }));
vi.mock("@/lib/authz/guard", () => ({ currentActor: async () => ({ orgId: "org-1" }) }));
vi.mock("@/lib/auth/owner", () => ({
	// `findOwnerScope` answers null for no session and THROWS when the read failed. The previous
	// head read `getOwnerScope`, which throws for both; it is mocked to the same answers so a test
	// that expects a refusal fails on its assertion there, not on a missing mock.
	findOwnerScope: async () => {
		if (h.lookupFails) throw new Error("session table unreachable");
		return h.caller;
	},
	getOwnerScope: async () => {
		if (h.lookupFails || !h.caller) throw new Error("unauthorized");
		return h.caller;
	},
}));
vi.mock("@/lib/authz/active-owner", () => ({ removalOwnerRefusal: h.removalOwnerRefusal }));
vi.mock("@/lib/authz/grants", () => ({ revokeMemberGrant: h.revokeMemberGrant }));
vi.mock("@/lib/authz/member-exit", () => ({
	cancelPendingInvitationsFrom: h.cancelPendingInvitationsFrom,
}));
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		select: () => {
			let table: unknown;
			const chain: Record<string, unknown> = {};
			chain.from = (t: unknown) => {
				table = t;
				return chain;
			};
			let predicate: unknown;
			chain.where = (p: unknown) => {
				predicate = p;
				return chain;
			};
			chain.limit = () => chain;
			chain.then = (resolve: (v: unknown) => void) => {
				// A member read for an org listed in `memberByOrg` answers that org's rows, so a test
				// can tell WHICH org the guard asked about; otherwise the table's rows.
				if (table === member) {
					for (const [org, rows] of h.memberByOrg) {
						if (mentions(predicate, org)) return resolve(rows);
					}
				}
				resolve(h.byTable.get(table) ?? []);
			};
			return chain;
		},
	}),
}));
vi.mock("better-auth/next-js", () => ({
	toNextJsHandler: () => ({ GET: vi.fn(), POST: h.post }),
}));

import { POST } from "@/app/api/auth/[...all]/route";

/** Whether `value` (a drizzle predicate) carries the string `needle` anywhere inside it. */
function mentions(value: unknown, needle: string, seen = new WeakSet<object>()): boolean {
	if (value === needle) return true;
	if (typeof value !== "object" || value === null || seen.has(value)) return false;
	seen.add(value);
	return Object.values(value).some((v) => mentions(v, needle, seen));
}

/** A POST to a better-auth organization endpoint with a JSON body. */
function orgPost(action: string, body: unknown): Request {
	return new Request(`https://app.test/api/auth/organization/${action}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** A POST to a @better-auth/sso endpoint with a JSON body. */
function ssoPost(action: string, body: unknown): Request {
	return new Request(`https://app.test/api/auth/sso/${action}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	h.post.mockImplementation(async () => new Response("post-handler"));
	h.caller = h.signedIn();
	h.lookupFails = false;
	h.byTable = new Map();
	h.memberByOrg = new Map();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a caller whose membership is not active may not manage the org", () => {
	it("refuses invite-member from a SUSPENDED member before better-auth runs; an active member and a signed-out request reach it", async () => {
		h.byTable.set(member, [{ id: "m-1", status: "suspended" }]);
		const res = await POST(
			orgPost("invite-member", { organizationId: "org-1", email: "x@example.test", role: "admin" }),
		);
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ code: "MEMBER_NOT_ACTIVE" });
		expect(h.post).not.toHaveBeenCalled();

		h.byTable.set(member, [{ id: "m-1", status: "active" }]);
		await POST(orgPost("invite-member", { organizationId: "org-1", email: "x@example.test" }));
		expect(h.post).toHaveBeenCalledTimes(1);

		// No session: better-auth answers its own 401, so the request is handed to it.
		h.caller = null;
		h.byTable.set(member, [{ id: "m-1", status: "suspended" }]);
		await POST(orgPost("invite-member", { organizationId: "org-1", email: "x@example.test" }));
		expect(h.post).toHaveBeenCalledTimes(2);
	});

	it.each(["update-member-role", "remove-member", "add-team-member", "update"])(
		"refuses %s from a suspended member, with no org in the body (the session's active org is read)",
		async (action) => {
			h.byTable.set(member, [{ id: "m-1", status: "suspended" }]);
			const res = await POST(orgPost(action, { memberId: "m-2", role: "owner" }));
			expect(res.status).toBe(403);
			expect(h.post).not.toHaveBeenCalled();
		},
	);

	it("refuses cancel-invitation from a suspended member of the INVITATION's org", async () => {
		h.byTable.set(invitation, [{ organizationId: "org-1" }]);
		h.byTable.set(member, [{ id: "m-1", status: "suspended" }]);
		const res = await POST(orgPost("cancel-invitation", { invitationId: "inv-1" }));
		expect(res.status).toBe(403);
		expect(h.post).not.toHaveBeenCalled();
	});
});

describe("leave", () => {
	it("refuses the last ACTIVE owner leaving, with core's sentence, before better-auth runs", async () => {
		h.byTable.set(member, [{ id: "m-owner", status: "active" }]);
		h.removalOwnerRefusal.mockResolvedValueOnce("only active owner");
		const res = await POST(orgPost("leave", { organizationId: "org-1" }));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			code: "ORGANIZATION_NEEDS_AN_ACTIVE_OWNER",
			message: "only active owner",
		});
		expect(h.removalOwnerRefusal).toHaveBeenCalledWith("org-1", "m-owner");
		expect(h.post).not.toHaveBeenCalled();
	});

	it("revokes the leaver's grants once better-auth has removed them, and not when it refused", async () => {
		h.byTable.set(member, [{ id: "m-2", status: "active" }]);
		const res = await POST(orgPost("leave", { organizationId: "org-1" }));
		expect(await res.text()).toBe("post-handler");
		expect(h.revokeMemberGrant).toHaveBeenCalledWith("org-1", "user-1");

		h.revokeMemberGrant.mockClear();
		h.post.mockImplementationOnce(async () => new Response("{}", { status: 400 }));
		await POST(orgPost("leave", { organizationId: "org-1" }));
		expect(h.revokeMemberGrant).not.toHaveBeenCalled();
	});

	// #5484: left pending, a leaver's invitations become acceptable again if they are re-added.
	it("cancels the leaver's pending invitations into that org once better-auth has removed them, and not when it refused", async () => {
		h.byTable.set(member, [{ id: "m-2", status: "active" }]);
		await POST(orgPost("leave", { organizationId: "org-1" }));
		expect(h.cancelPendingInvitationsFrom).toHaveBeenCalledWith(
			expect.anything(),
			"org-1",
			"user-1",
		);

		h.cancelPendingInvitationsFrom.mockClear();
		h.post.mockImplementationOnce(async () => new Response("{}", { status: 400 }));
		await POST(orgPost("leave", { organizationId: "org-1" }));
		expect(h.cancelPendingInvitationsFrom).not.toHaveBeenCalled();
	});
});

describe("remove-member cancels the removed member's pending invitations (#5484)", () => {
	it("cancels them in the org better-auth's response names, for the member it names; nothing when it refused", async () => {
		h.byTable.set(member, [{ id: "m-1", status: "active" }]);
		h.post.mockImplementationOnce(async () =>
			Response.json({
				member: { id: "m-9", userId: "user-9", organizationId: "org-1", role: "admin" },
			}),
		);
		const res = await POST(orgPost("remove-member", { memberIdOrEmail: "m-9" }));
		expect(res.status).toBe(200);
		// The response still reaches the client intact.
		expect(await res.json()).toMatchObject({ member: { userId: "user-9" } });
		expect(h.cancelPendingInvitationsFrom).toHaveBeenCalledWith(
			expect.anything(),
			"org-1",
			"user-9",
		);

		h.cancelPendingInvitationsFrom.mockClear();
		h.post.mockImplementationOnce(async () => Response.json({ code: "x" }, { status: 400 }));
		await POST(orgPost("remove-member", { memberIdOrEmail: "m-9" }));
		expect(h.cancelPendingInvitationsFrom).not.toHaveBeenCalled();
	});
});

describe("a suspended admin may not change the org's SSO providers (#5484)", () => {
	it.each(["update-provider", "delete-provider", "request-domain-verification", "verify-domain"])(
		"refuses %s for a provider in an org where the caller is suspended, before the plugin runs",
		async (action) => {
			h.byTable.set(ssoProvider, [{ organizationId: "org-1" }]);
			h.byTable.set(member, [{ id: "m-1", status: "suspended" }]);
			const res = await POST(ssoPost(action, { providerId: "okta" }));
			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({ code: "MEMBER_NOT_ACTIVE" });
			expect(h.post).not.toHaveBeenCalled();
		},
	);

	it("refuses register into an org the body names; an active admin, a signed-out request and an SSO read reach the plugin", async () => {
		h.memberByOrg.set("org-1", [{ id: "m-1", status: "suspended" }]);
		const refused = await POST(ssoPost("register", { organizationId: "org-1", providerId: "okta" }));
		expect(refused.status).toBe(403);
		expect(h.post).not.toHaveBeenCalled();

		h.memberByOrg.set("org-1", [{ id: "m-1", status: "active" }]);
		await POST(ssoPost("register", { organizationId: "org-1", providerId: "okta" }));
		expect(h.post).toHaveBeenCalledTimes(1);

		h.caller = null;
		h.memberByOrg.set("org-1", [{ id: "m-1", status: "suspended" }]);
		await POST(ssoPost("register", { organizationId: "org-1", providerId: "okta" }));
		expect(h.post).toHaveBeenCalledTimes(2);

		// The sign-in flow is not a management action.
		h.caller = h.signedIn();
		await POST(ssoPost("sign-in", { providerId: "okta" }));
		expect(h.post).toHaveBeenCalledTimes(3);
	});

	it("answers a 500 and never reaches the plugin when the session read throws", async () => {
		h.lookupFails = true;
		const res = await POST(ssoPost("delete-provider", { providerId: "okta" }));
		expect(res.status).toBe(500);
		expect(h.post).not.toHaveBeenCalled();
	});
});

describe("the guard fails closed when the session cannot be read (#5472)", () => {
	// Against the previous head a failed read was treated as "no session", the guard skipped, and
	// the request went to better-auth, whose own session read could then succeed.
	it.each(["invite-member", "remove-member", "update-member-role", "leave"])(
		"answers %s with a 500 and never reaches better-auth when the session read throws",
		async (action) => {
			h.lookupFails = true;
			h.byTable.set(member, [{ id: "m-1", status: "suspended" }]);
			const res = await POST(orgPost(action, { organizationId: "org-1", memberId: "m-2" }));
			expect(res.status).toBe(500);
			expect(await res.json()).toMatchObject({ code: "SESSION_LOOKUP_FAILED" });
			expect(h.post).not.toHaveBeenCalled();
		},
	);
});

describe("update-team targets the org better-auth acts in (#5472)", () => {
	// better-auth's update-team reads `data.organizationId || activeOrganizationId`, never a top-level
	// `organizationId`. Against the previous head the guard read the top-level field first, so a body
	// naming an org the caller has no row in was let through while better-auth renamed a team in B.
	it("refuses a suspended member of data.organizationId even when a top-level organizationId names another org", async () => {
		// No row in org-elsewhere (the guard lets a caller with no row through to better-auth);
		// a SUSPENDED row in org-B, the org better-auth acts in.
		h.memberByOrg.set("org-elsewhere", []);
		h.memberByOrg.set("org-B", [{ id: "m-1", status: "suspended" }]);
		const res = await POST(
			orgPost("update-team", {
				organizationId: "org-elsewhere",
				teamId: "t-1",
				data: { organizationId: "org-B", name: "renamed" },
			}),
		);
		expect(res.status).toBe(403);
		expect(h.post).not.toHaveBeenCalled();
	});
});
