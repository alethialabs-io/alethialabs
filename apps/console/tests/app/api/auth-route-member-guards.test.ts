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
import { invitation, member } from "@/lib/db/schema";

/** The signed-in caller `getOwnerScope` answers with; null means no session. */
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
		byTable: new Map<unknown, unknown[]>(),
		removalOwnerRefusal: vi.fn(
			async (_org: string, _member: string): Promise<string | null> => null,
		),
		revokeMemberGrant: vi.fn(async (_org: string, _user: string) => undefined),
	};
});

vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/auth/trusted-ip", () => ({ trustedIpFailure: () => null }));
vi.mock("@/lib/authz/entitlements", () => ({ getEntitlements: () => ({ organizations: true }) }));
vi.mock("@/lib/authz/guard", () => ({ currentActor: async () => ({ orgId: "org-1" }) }));
vi.mock("@/lib/auth/owner", () => ({
	getOwnerScope: async () => {
		if (!h.caller) throw new Error("unauthorized");
		return h.caller;
	},
}));
vi.mock("@/lib/authz/active-owner", () => ({ removalOwnerRefusal: h.removalOwnerRefusal }));
vi.mock("@/lib/authz/grants", () => ({ revokeMemberGrant: h.revokeMemberGrant }));
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		select: () => {
			let table: unknown;
			const chain: Record<string, unknown> = {};
			chain.from = (t: unknown) => {
				table = t;
				return chain;
			};
			chain.where = () => chain;
			chain.limit = () => chain;
			chain.then = (resolve: (v: unknown) => void) => resolve(h.byTable.get(table) ?? []);
			return chain;
		},
	}),
}));
vi.mock("better-auth/next-js", () => ({
	toNextJsHandler: () => ({ GET: vi.fn(), POST: h.post }),
}));

import { POST } from "@/app/api/auth/[...all]/route";

/** A POST to a better-auth organization endpoint with a JSON body. */
function orgPost(action: string, body: unknown): Request {
	return new Request(`https://app.test/api/auth/organization/${action}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	h.post.mockImplementation(async () => new Response("post-handler"));
	h.caller = h.signedIn();
	h.byTable = new Map();
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
});
