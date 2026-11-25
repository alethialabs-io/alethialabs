// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The consent screen's read (AGT-L2, SPEC §5b): the states that need no organization lookup, and one
// org's answer — what the role allows, what may be ticked, and an org that refuses the app.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	answered: vi.fn(),
	orgRefusal: vi.fn(),
	roleAllows: vi.fn(),
	existing: vi.fn(),
	scope: vi.fn(),
	viewable: vi.fn(),
	policy: vi.fn(),
	selects: [] as unknown[][],
}));

/** A drizzle-shaped select chain answering the next queued row list. */
function chain(): unknown {
	const rows = h.selects.shift() ?? [];
	const c: Record<string, unknown> = {};
	for (const m of ["from", "innerJoin", "where", "limit"]) c[m] = () => c;
	c.then = (resolve: (v: unknown) => void) => resolve(rows);
	return c;
}

vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({ select: () => chain() }),
	withActorScope: async (_a: unknown, fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock("@/lib/auth/scope", () => ({ getActiveScope: h.scope }));
vi.mock("@/lib/jobs/visibility", () => ({ viewableProjectIds: h.viewable }));
vi.mock("@/lib/approvals/context", () => ({ readAgentPolicy: h.policy }));
vi.mock("@/lib/agents/consent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/agents/consent")>()),
	consentAlreadyAnswered: h.answered,
	orgConsentRefusal: h.orgRefusal,
	scopesRoleAllows: h.roleAllows,
	existingGrant: h.existing,
}));

import { readConsentContext } from "@/lib/agents/consent-context";

const USER = "00000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-4000-8000-0000000000aa";
const NOW = new Date("2026-11-24T12:00:00Z");
const query = (exp: number) =>
	new URLSearchParams({
		client_id: "https://cursor.com/c.json",
		scope: "openid read plan apply billing:write",
		redirect_uri: "https://cursor.com/cb",
		exp: String(Math.floor(NOW.getTime() / 1000) + exp),
		sig: "s",
	}).toString();

beforeEach(() => {
	vi.clearAllMocks();
	h.selects.length = 0;
	h.answered.mockResolvedValue(false);
	h.orgRefusal.mockResolvedValue(null);
	h.roleAllows.mockResolvedValue(["read", "plan"]);
	h.existing.mockResolvedValue(null);
	h.viewable.mockResolvedValue([]);
	h.policy.mockResolvedValue({ agentAccessEnabled: true, agentsMayNotApplyToProduction: true, requireDifferentApprover: false, approvalTtlMinutes: 60 });
	h.scope.mockImplementation(async (userId: string, orgId: string) => ({ userId, orgId }));
});

describe("readConsentContext", () => {
	it("says missing for a page opened directly", async () => {
		expect(await readConsentContext(USER, "", NOW)).toEqual({ state: "missing" });
	});

	it("says expired past the signed expiry", async () => {
		expect(await readConsentContext(USER, query(-10), NOW)).toEqual({ state: "expired" });
	});

	it("says answered for a request already allowed or denied", async () => {
		h.answered.mockResolvedValue(true);
		expect(await readConsentContext(USER, query(300), NOW)).toEqual({ state: "answered" });
	});

	it("reads the app, the split scopes and each org's answer", async () => {
		// The client row, then the memberships.
		h.selects.push([{ name: "cursor-mcp", icon: null, discovery: "https://cursor.com/c.json" }]);
		h.selects.push([{ id: ORG, name: "acme", role: "viewer" }]);
		const context = await readConsentContext(USER, query(300), NOW);
		expect(context.state).toBe("ready");
		if (context.state !== "ready") return;
		expect(context.identity.name).toBe("Cursor");
		expect(context.verified).toBe(true);
		expect(context.redirectHost).toBe("cursor.com");
		expect(context.requested).toEqual({ agent: ["read", "plan", "apply"], oidc: ["openid"], unknown: ["billing:write"] });
		expect(context.orgs).toEqual([
			expect.objectContaining({ id: ORG, role: "viewer", refusal: null, agentsKeptOffProduction: true, roleAllows: ["read", "plan"], grantable: ["read", "plan"], projects: [] }),
		]);
	});

	it("offers the personal workspace to someone in no organization", async () => {
		h.selects.push([{ name: null, icon: null, discovery: null }]);
		h.selects.push([]);
		const context = await readConsentContext(USER, query(300), NOW);
		expect(context.state === "ready" && context.orgs.map((o) => ({ id: o.id, personal: o.personal }))).toEqual([{ id: USER, personal: true }]);
		expect(context.state === "ready" && context.verified).toBe(false);
	});

	it("leaves out an org the person is not an active member of", async () => {
		h.selects.push([{ name: null, icon: null, discovery: null }]);
		h.selects.push([{ id: ORG, name: "acme", role: "viewer" }]);
		h.scope.mockResolvedValue({ userId: USER, orgId: USER });
		const context = await readConsentContext(USER, query(300), NOW);
		expect(context.state === "ready" && context.orgs).toEqual([]);
	});
});
