// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6115 (ADR 0005 §10 R7, spec risk 4): the second tenancy path. An open stream cannot re-run
// `currentActor()` from a timer, so `reauthorize` re-asks its questions from the snapshot. Each arm
// of `currentActor()` + `urlScopedOrgId()` it mirrors is one case here, plus the rule that a FAILED
// lookup throws rather than reporting a revocation or a pass.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
	const memberRows: Array<{ id: string }> = [];
	const whereArgs: unknown[] = [];
	return {
		getSession: vi.fn(),
		getActiveScope: vi.fn(),
		tenancyMode: vi.fn(),
		hasAccepted: vi.fn(),
		memberRows,
		can: vi.fn(),
		whereArgs,
	};
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: h.getSession } } }));
vi.mock("@/lib/auth/scope", () => ({
	getActiveScope: h.getActiveScope,
	tenancyMode: h.tenancyMode,
}));
vi.mock("@/lib/authz", () => ({ getPdp: () => ({ can: h.can }) }));
vi.mock("@/lib/billing/eligibility", () => ({ hasAcceptedCurrentDocuments: h.hasAccepted }));
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		select: () => ({
			from: () => ({
				where: (w: unknown) => {
					h.whereArgs.push(w);
					return { limit: async () => h.memberRows };
				},
			}),
		}),
	}),
}));

import { EditionMisconfiguredError } from "@/lib/auth/errors";
import { BUILT_IN_ROLES } from "@/lib/authz/registry";
import { capabilitiesOf, reauthorize } from "@/lib/realtime/reauth";

const USER = "22222222-2222-4222-8222-222222222222";
const ORG = "11111111-1111-4111-8111-111111111111";
const ELSEWHERE = "66666666-6666-4666-8666-666666666666";
const SNAP = { userId: USER, addressOrgId: ORG, cookie: "better-auth.session_token=abc" };

beforeEach(() => {
	h.getSession.mockReset().mockResolvedValue({ user: { id: USER }, session: { id: "s1" } });
	h.getActiveScope.mockReset().mockResolvedValue({ userId: USER, orgId: ORG });
	h.tenancyMode.mockReset().mockReturnValue("multi-tenant");
	h.hasAccepted.mockReset().mockResolvedValue(true);
	h.memberRows = [{ id: "m1" }];
	h.whereArgs = [];
	h.can.mockReset().mockResolvedValue({ allowed: false });
});

describe("reauthorize", () => {
	it("passes a live session of the same user, an active member, Terms accepted", async () => {
		const result = await reauthorize(SNAP);
		expect(result).toEqual({
			ok: true,
			actor: { userId: USER, orgId: ORG, credential: "session" },
			caps: { platformView: false, manageSupport: false, viewAlerts: false, memberView: false },
		});
		// The session is read from the SNAPSHOTTED cookie, not from a request scope.
		const headers: Headers = h.getSession.mock.calls[0][0].headers;
		expect(headers.get("cookie")).toBe(SNAP.cookie);
		expect(h.getActiveScope).toHaveBeenCalledWith(USER, ORG);
	});

	it("revokes as unauthorized when the session is gone", async () => {
		h.getSession.mockResolvedValue(null);
		await expect(reauthorize(SNAP)).resolves.toEqual({ ok: false, reason: "unauthorized" });
	});

	it("revokes as unauthorized when the cookie now belongs to someone else", async () => {
		h.getSession.mockResolvedValue({ user: { id: ELSEWHERE }, session: { id: "s2" } });
		await expect(reauthorize(SNAP)).resolves.toEqual({ ok: false, reason: "unauthorized" });
	});

	it("revokes as not-member when there is no ACTIVE member row (removed or suspended)", async () => {
		h.memberRows = [];
		await expect(reauthorize(SNAP)).resolves.toEqual({ ok: false, reason: "not-member" });
		expect(h.getActiveScope).not.toHaveBeenCalled();
	});

	it("does not ask for a member row in the personal scope", async () => {
		h.memberRows = [];
		h.getActiveScope.mockResolvedValue({ userId: USER, orgId: USER });
		const result = await reauthorize({ ...SNAP, addressOrgId: USER });
		expect(result.ok).toBe(true);
		expect(h.whereArgs).toEqual([]);
	});

	it("revokes as terms when the current Terms are no longer accepted", async () => {
		h.hasAccepted.mockResolvedValue(false);
		await expect(reauthorize(SNAP)).resolves.toEqual({ ok: false, reason: "terms" });
	});

	it("revokes as not-member when the resolver lands on a different org", async () => {
		h.getActiveScope.mockResolvedValue({ userId: USER, orgId: ELSEWHERE });
		await expect(reauthorize(SNAP)).resolves.toEqual({ ok: false, reason: "not-member" });
	});

	it("accepts a collapse to the personal scope ONLY in the single-tenant edition", async () => {
		h.getActiveScope.mockResolvedValue({ userId: USER, orgId: USER });
		h.tenancyMode.mockReturnValue("single-tenant");
		expect((await reauthorize(SNAP)).ok).toBe(true);
		h.tenancyMode.mockReturnValue("multi-tenant");
		await expect(reauthorize(SNAP)).resolves.toEqual({ ok: false, reason: "not-member" });
	});

	it("throws, rather than answering, in an unconfigured edition", async () => {
		h.getActiveScope.mockResolvedValue({ userId: USER, orgId: USER });
		h.tenancyMode.mockReturnValue("unconfigured");
		await expect(reauthorize(SNAP)).rejects.toBeInstanceOf(EditionMisconfiguredError);
	});

	it("throws when a lookup fails — never a revocation, never a pass", async () => {
		h.getSession.mockRejectedValue(new Error("db down"));
		await expect(reauthorize(SNAP)).rejects.toThrow("db down");
	});
});

describe("capabilitiesOf", () => {
	it("asks the PDP with can() for runner view (what the platform reads gate on), manage_support, view_alerts and member view", async () => {
		h.can.mockImplementation(async (_a: unknown, action: string, ref: { type: string }) => ({
			allowed: (action === "view" && ref.type === "runner") || action === "view_alerts",
		}));
		await expect(capabilitiesOf({ credential: "session", userId: USER, orgId: ORG })).resolves.toEqual({
			platformView: true,
			manageSupport: false,
			viewAlerts: true,
			memberView: false,
		});
		expect(h.can).toHaveBeenCalledWith({ credential: "session", userId: USER, orgId: ORG }, "view_alerts", { type: "alert" });
		expect(h.can).toHaveBeenCalledWith({ credential: "session", userId: USER, orgId: ORG }, "view", { type: "runner" });
		// #6129: `access` hints (grants, custom roles) reach only a `member:view` holder.
		expect(h.can).toHaveBeenCalledWith({ credential: "session", userId: USER, orgId: ORG }, "view", { type: "member" });
		expect(h.can).toHaveBeenCalledWith({ credential: "session", userId: USER, orgId: ORG }, "manage_support", {
			type: "support_case",
		});
	});

	it("the built-in operator role hears platform rows on self-managed: it reads them (#6123)", async () => {
		// The PDP answered from the REAL built-in grant list. The operator reads managed runners and pool
		// cards (both read on `runner:view`) and holds no `fleet:view` — so a capability derived from
		// `fleet` would leave its runners page stale with the poll gone.
		const granted = new Set(BUILT_IN_ROLES.operator === "*" ? [] : BUILT_IN_ROLES.operator);
		expect(granted.has("runner:view")).toBe(true);
		expect(granted.has("fleet:view")).toBe(false);
		h.can.mockImplementation(async (_a: unknown, action: string, resource: { type: string }) => ({
			allowed: [...granted].some((key) => key === `${resource.type}:${action}`),
		}));
		await expect(capabilitiesOf({ credential: "session", userId: USER, orgId: ORG })).resolves.toMatchObject({ platformView: true });
	});

	it("never grants platform view on a hosted deployment, whatever the PDP says (#6123)", async () => {
		vi.stubEnv("ALETHIA_DEPLOYMENT_MODE", "hosted");
		try {
			h.can.mockResolvedValue({ allowed: true });
			await expect(capabilitiesOf({ credential: "session", userId: USER, orgId: ORG })).resolves.toEqual({
				platformView: false,
				manageSupport: true,
				viewAlerts: true,
				memberView: true,
			});
			expect(h.can).not.toHaveBeenCalledWith({ credential: "session", userId: USER, orgId: ORG }, "view", { type: "runner" });
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("reads a PDP error as no capability", async () => {
		h.can.mockRejectedValue(new Error("pdp down"));
		await expect(capabilitiesOf({ credential: "session", userId: USER, orgId: ORG })).resolves.toEqual({
			platformView: false,
			manageSupport: false,
			viewAlerts: false,
			memberView: false,
		});
	});
});
