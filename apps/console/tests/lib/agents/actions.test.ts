// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Mocked-boundary tests for the AGT-L2 server actions: the agent policy write, the console's service
// token actions, disconnecting an agent, and answering the consent screen. The PDP gate, the scoped
// transaction and the lib/agents data functions are stubbed (each is tested on its own, the data ones
// against Postgres); what is asserted here is each action's ORDER of checks and what it refuses.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	can: vi.fn(),
	authorizeDeferred: vi.fn(),
	authorizeQuiet: vi.fn(),
	authorizeInOrg: vi.fn(),
	getSession: vi.fn(),
	handler: vi.fn(),
	recordActivity: vi.fn(),
	recordAllowed: vi.fn(),
	mint: vi.fn(),
	revoke: vi.fn(),
	facts: vi.fn(),
	limits: vi.fn(),
	writeAutoApprove: vi.fn(),
	writePolicy: vi.fn(),
	revokeGrant: vi.fn(),
	answered: vi.fn(),
	markAnswered: vi.fn(),
	orgRefusal: vi.fn(),
	roleAllows: vi.fn(),
	writeGrant: vi.fn(),
	viewable: vi.fn(),
	grantableProjects: vi.fn(),
	snapshot: vi.fn(),
	restore: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: "session=abc", origin: "https://console.test" }) }));
vi.mock("@/lib/authz", () => ({ getPdp: () => ({ can: h.can }) }));
vi.mock("@/lib/authz/guard", () => ({
	authorizeDeferred: h.authorizeDeferred,
	authorizeQuiet: h.authorizeQuiet,
	authorizeInOrg: h.authorizeInOrg,
}));
vi.mock("@/lib/authz/activity", () => ({ recordActivity: h.recordActivity, recordAllowed: h.recordAllowed }));
vi.mock("@/lib/alerts/emit", () => ({ emitActionEvent: vi.fn() }));
vi.mock("@/lib/db", () => ({ withActorScope: async (_actor: unknown, fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/auth", () => ({
	auth: { api: { getSession: h.getSession }, handler: h.handler, options: { baseURL: "https://console.test" } },
}));
vi.mock("@/lib/cli/service-token", () => ({ mintServiceToken: h.mint, revokeServiceToken: h.revoke }));
vi.mock("@/lib/jobs/visibility", () => ({ viewableProjectIds: h.viewable }));
vi.mock("@/lib/agents/service-tokens", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/agents/service-tokens")>()),
	autoApproveFacts: h.facts,
	activeTokenLimits: h.limits,
	writeAutoApprove: h.writeAutoApprove,
}));
vi.mock("@/lib/agents/policy", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/agents/policy")>()),
	writeAgentPolicy: h.writePolicy,
}));
vi.mock("@/lib/agents/grants", () => ({ revokeAgentGrant: h.revokeGrant }));
vi.mock("@/lib/agents/consent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/agents/consent")>()),
	consentAlreadyAnswered: h.answered,
	markConsentAnswered: h.markAnswered,
	orgConsentRefusal: h.orgRefusal,
	scopesRoleAllows: h.roleAllows,
	writeGrantForConsent: h.writeGrant,
	grantableProjectIds: h.grantableProjects,
	readConsentSnapshot: h.snapshot,
	restoreConsent: h.restore,
}));

import { disconnectAgent } from "@/app/server/actions/agents/connections";
import { answerAgentConsent } from "@/app/server/actions/agents/consent";
import { updateAgentPolicy } from "@/app/server/actions/agents/policy";
import {
	createConsoleServiceToken,
	revokeConsoleServiceToken,
	updateServiceTokenAutoApprove,
} from "@/app/server/actions/agents/service-tokens";
import { DEFAULT_AGENT_POLICY_SETTINGS } from "@/lib/agents/policy";
import { ForbiddenError } from "@/lib/authz/types";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-000000000001";
const ENV = "00000000-0000-4000-8000-0000000000e1";
const PROD = "00000000-0000-4000-8000-0000000000e2";
const PROJECT = "00000000-0000-4000-8000-0000000000a1";
const TOKEN = "00000000-0000-4000-8000-0000000000b1";
const actor = { userId: USER, orgId: ORG, credential: "session" as const };

/** The refusal's message, for a refusal kind that carries one; null otherwise. */
function messageOf(result: { ok: boolean; error?: unknown }): string | null {
	const error = result.error;
	if (typeof error !== "object" || error === null || !("message" in error)) return null;
	return typeof error.message === "string" ? error.message : null;
}

beforeEach(() => {
	vi.clearAllMocks();
	h.authorizeDeferred.mockResolvedValue(actor);
	h.authorizeQuiet.mockResolvedValue(actor);
	h.authorizeInOrg.mockResolvedValue(actor);
	h.can.mockResolvedValue({ allowed: true });
	h.facts.mockResolvedValue([
		{ id: ENV, projectId: PROJECT, stage: "staging" },
		{ id: PROD, projectId: PROJECT, stage: "production" },
	]);
	h.mint.mockResolvedValue({ id: TOKEN, token: "alethia_sat_secret", token_prefix: "alethia_sat_secr" });
	h.writeAutoApprove.mockResolvedValue(true);
});

describe("updateAgentPolicy", () => {
	it("is refused without org:manage_agents and writes nothing", async () => {
		h.authorizeDeferred.mockRejectedValueOnce(new ForbiddenError("manage_agents", { type: "org" }, "no_grant"));
		const result = await updateAgentPolicy({ agentAccessEnabled: false });
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error.kind).toBe("forbidden");
		expect(h.writePolicy).not.toHaveBeenCalled();
	});

	it("writes the change and records what changed", async () => {
		h.writePolicy.mockResolvedValue({ ...DEFAULT_AGENT_POLICY_SETTINGS, agentAccessEnabled: false });
		const result = await updateAgentPolicy({ agentAccessEnabled: false });
		expect(result.ok).toBe(true);
		expect(h.authorizeDeferred).toHaveBeenCalledWith("manage_agents", { type: "org" });
		expect(h.recordActivity).toHaveBeenCalledWith(actor, "update_agent_policy", { type: "org", id: ORG }, { reason: "agent access off" });
	});
});

describe("createConsoleServiceToken", () => {
	it("mints without asking for org:manage_agents when no environment is chosen", async () => {
		const result = await createConsoleServiceToken({ name: "ci" });
		expect(result.ok).toBe(true);
		expect(h.can).not.toHaveBeenCalled();
		expect(h.writeAutoApprove).not.toHaveBeenCalled();
	});

	it("refuses auto-approve environments without org:manage_agents, before minting", async () => {
		h.can.mockResolvedValue({ allowed: false, reason: "no_grant" });
		const result = await createConsoleServiceToken({ name: "ci", autoApproveEnvironmentIds: [ENV] });
		expect(!result.ok && result.error.kind).toBe("forbidden");
		expect(h.mint).not.toHaveBeenCalled();
	});

	it("refuses a production environment, before minting", async () => {
		const result = await createConsoleServiceToken({ name: "ci", autoApproveEnvironmentIds: [PROD] });
		expect(!result.ok && result.error.kind).toBe("conflict");
		expect(messageOf(result)).toBe("Production environments always need a person.");
		expect(h.mint).not.toHaveBeenCalled();
	});

	it("refuses auto-approve on a token without the Deploy scope", async () => {
		const result = await createConsoleServiceToken({ name: "ci", scopes: ["read", "plan"], autoApproveEnvironmentIds: [ENV] });
		expect(!result.ok && result.error.kind).toBe("conflict");
	});

	it("mints, then stores the list and records it", async () => {
		const result = await createConsoleServiceToken({ name: "ci", autoApproveEnvironmentIds: [ENV, ENV] });
		expect(result.ok && result.data).toMatchObject({ id: TOKEN, token: "alethia_sat_secret", autoApproveEnvironmentIds: [ENV] });
		expect(h.writeAutoApprove).toHaveBeenCalledWith(ORG, TOKEN, [ENV]);
		expect(h.recordActivity).toHaveBeenCalledWith(actor, "set_token_auto_approve", { type: "service_token", id: TOKEN }, expect.objectContaining({ resourceName: "ci" }));
	});
});

describe("updateServiceTokenAutoApprove", () => {
	it("needs org:manage_agents as well as org:manage_tokens", async () => {
		h.can.mockResolvedValue({ allowed: false, reason: "no_grant" });
		const result = await updateServiceTokenAutoApprove({ tokenId: TOKEN, environmentIds: [ENV] });
		expect(!result.ok && result.error.kind).toBe("forbidden");
		expect(h.authorizeDeferred).toHaveBeenCalledWith("manage_tokens", { type: "org" });
		expect(h.writeAutoApprove).not.toHaveBeenCalled();
	});

	it("answers not-found for a token that is not active in the org", async () => {
		h.limits.mockResolvedValue(null);
		const result = await updateServiceTokenAutoApprove({ tokenId: TOKEN, environmentIds: [] });
		expect(!result.ok && result.error.kind).toBe("not-found");
	});

	it("checks the list against the token's own limits", async () => {
		h.limits.mockResolvedValue({ id: TOKEN, name: "ci", scopes: ["apply"], projectIds: ["another-project"] });
		const result = await updateServiceTokenAutoApprove({ tokenId: TOKEN, environmentIds: [ENV] });
		expect(messageOf(result)).toMatch(/isn't in a project this token can use/);
	});

	it("lets an empty list return the token to asking a person", async () => {
		h.limits.mockResolvedValue({ id: TOKEN, name: "ci", scopes: ["read"], projectIds: null });
		const result = await updateServiceTokenAutoApprove({ tokenId: TOKEN, environmentIds: [] });
		expect(result.ok && result.data).toEqual({ tokenId: TOKEN, environmentIds: [] });
	});
});

describe("revokeConsoleServiceToken", () => {
	it("revokes an active token of the org and records it by name", async () => {
		h.limits.mockResolvedValue({ id: TOKEN, name: "ci", scopes: ["read"], projectIds: null });
		h.revoke.mockResolvedValue(true);
		const result = await revokeConsoleServiceToken({ tokenId: TOKEN });
		expect(result.ok).toBe(true);
		expect(h.revoke).toHaveBeenCalledWith({ id: TOKEN, organizationId: ORG });
	});

	it("answers not-found otherwise", async () => {
		h.limits.mockResolvedValue(null);
		expect((await revokeConsoleServiceToken({ tokenId: TOKEN })).ok).toBe(false);
	});
});

describe("disconnectAgent", () => {
	it("answers not-found when there is no live grant of the caller's", async () => {
		h.revokeGrant.mockResolvedValue(null);
		const result = await disconnectAgent({ grantId: TOKEN });
		expect(!result.ok && result.error.kind).toBe("not-found");
		expect(h.revokeGrant).toHaveBeenCalledWith({}, ORG, USER, TOKEN);
	});

	it("records the disconnect under the app's name", async () => {
		h.revokeGrant.mockResolvedValue("https://cursor.com/c.json");
		await disconnectAgent({ grantId: TOKEN });
		expect(h.recordActivity).toHaveBeenCalledWith(actor, "disconnect_agent", { type: "agent_grant", id: TOKEN }, { resourceName: "Cursor" });
	});
});

describe("answerAgentConsent", () => {
	const future = String(Math.floor(Date.now() / 1000) + 300);
	const SNAPSHOT = { clientId: "https://cursor.com/c.json", userId: USER, rows: [] };
	const query = (exp = future) =>
		new URLSearchParams({ client_id: "https://cursor.com/c.json", scope: "openid read plan apply", exp, sig: "s" }).toString();

	beforeEach(() => {
		h.getSession.mockResolvedValue({ user: { id: USER }, session: { id: "s" } });
		h.answered.mockResolvedValue(false);
		h.orgRefusal.mockResolvedValue(null);
		h.roleAllows.mockResolvedValue(["read", "plan"]);
		h.writeGrant.mockResolvedValue("grant-1");
		h.viewable.mockResolvedValue([PROJECT]);
		h.handler.mockResolvedValue(new Response(JSON.stringify({ redirect: true, url: "https://cursor.com/cb?code=1" }), { status: 200 }));
		h.snapshot.mockResolvedValue(SNAPSHOT);
		h.restore.mockResolvedValue(undefined);
	});

	it("says expired for a request past its signed expiry, and calls nothing", async () => {
		const result = await answerAgentConsent({ oauthQuery: query("1000"), accept: true, orgId: ORG, scopes: ["read"] });
		expect(result.ok && result.data).toEqual({ outcome: "expired" });
		expect(h.handler).not.toHaveBeenCalled();
	});

	it("says answered for a request already allowed or denied", async () => {
		h.answered.mockResolvedValue(true);
		const result = await answerAgentConsent({ oauthQuery: query(), accept: false });
		expect(result.ok && result.data).toEqual({ outcome: "answered" });
		expect(h.handler).not.toHaveBeenCalled();
	});

	it("passes a deny through and records it answered", async () => {
		const result = await answerAgentConsent({ oauthQuery: query(), accept: false });
		expect(result.ok && result.data).toEqual({ outcome: "redirect", url: "https://cursor.com/cb?code=1" });
		expect(h.markAnswered).toHaveBeenCalledWith(expect.any(String), "denied", expect.any(Date));
		expect(h.writeGrant).not.toHaveBeenCalled();
	});

	it("refuses an org whose agent access is off", async () => {
		h.orgRefusal.mockResolvedValue("agent_access_disabled");
		const result = await answerAgentConsent({ oauthQuery: query(), accept: true, orgId: ORG, scopes: ["read"] });
		expect(messageOf(result)).toMatch(/Agents are turned off/);
		expect(h.handler).not.toHaveBeenCalled();
	});

	it("refuses a scope the role cannot grant", async () => {
		const result = await answerAgentConsent({ oauthQuery: query(), accept: true, orgId: ORG, scopes: ["read", "apply"] });
		expect(messageOf(result)).toMatch(/isn't one your role can grant/);
		expect(h.handler).not.toHaveBeenCalled();
	});

	it("refuses an allow with nothing ticked", async () => {
		const result = await answerAgentConsent({ oauthQuery: query(), accept: true, orgId: ORG, scopes: [] });
		expect(messageOf(result)).toBe("Choose at least one permission, or deny.");
	});

	it("refuses a project the person cannot use there", async () => {
		h.grantableProjects.mockResolvedValue([]);
		const result = await answerAgentConsent({ oauthQuery: query(), accept: true, orgId: ORG, scopes: ["read"], projectIds: [PROJECT] });
		expect(messageOf(result)).toMatch(/projects isn't one you can use/);
	});

	it("narrows the scope it hands Better Auth, writes the grant, then returns the redirect", async () => {
		const result = await answerAgentConsent({ oauthQuery: query(), accept: true, orgId: ORG, scopes: ["plan", "read"] });
		expect(result.ok && result.data).toEqual({ outcome: "redirect", url: "https://cursor.com/cb?code=1" });
		const request: Request = h.handler.mock.calls[0]?.[0];
		expect(new URL(request.url).pathname).toBe("/api/auth/oauth2/consent");
		expect(request.headers.get("cookie")).toBe("session=abc");
		expect(await request.json()).toMatchObject({ accept: true, scope: "openid plan read" });
		expect(h.writeGrant).toHaveBeenCalledWith({}, { orgId: ORG, userId: USER, clientId: "https://cursor.com/c.json", scopes: ["plan", "read"], projectIds: null });
		expect(h.markAnswered).toHaveBeenCalledWith(expect.any(String), "allowed", expect.any(Date));
		// The person's consent rows are read before Better Auth's call, and left alone once the grant is written.
		expect(h.snapshot).toHaveBeenCalledWith("https://cursor.com/c.json", USER);
		expect(h.snapshot.mock.invocationCallOrder[0]).toBeLessThan(h.handler.mock.invocationCallOrder[0] ?? 0);
		expect(h.restore).not.toHaveBeenCalled();
	});

	it("says invalid, writes no grant, and puts the consent back when Better Auth refuses the request", async () => {
		h.handler.mockResolvedValue(new Response(JSON.stringify({ error: "invalid_signature" }), { status: 400 }));
		const result = await answerAgentConsent({ oauthQuery: query(), accept: true, orgId: ORG, scopes: ["read"] });
		expect(result.ok && result.data).toEqual({ outcome: "invalid" });
		expect(h.writeGrant).not.toHaveBeenCalled();
		expect(h.markAnswered).not.toHaveBeenCalled();
		expect(h.restore).toHaveBeenCalledWith(SNAPSHOT);
	});

	it("puts the consent back, and returns no redirect, when the grant write fails", async () => {
		h.writeGrant.mockRejectedValue(new Error("connection lost"));
		const result = await answerAgentConsent({ oauthQuery: query(), accept: true, orgId: ORG, scopes: ["read"] });
		expect(result.ok).toBe(false);
		expect(h.restore).toHaveBeenCalledWith(SNAPSHOT);
		expect(h.markAnswered).not.toHaveBeenCalled();
		expect(h.recordActivity).not.toHaveBeenCalled();
	});

	it("puts the consent back when there was no consent row to bind the grant to", async () => {
		h.writeGrant.mockResolvedValue(null);
		const result = await answerAgentConsent({ oauthQuery: query(), accept: true, orgId: ORG, scopes: ["read"] });
		expect(result.ok).toBe(false);
		expect(h.restore).toHaveBeenCalledWith(SNAPSHOT);
		expect(h.markAnswered).not.toHaveBeenCalled();
	});

	it("still answers with the failure when putting the consent back fails too", async () => {
		h.writeGrant.mockRejectedValue(new Error("connection lost"));
		h.restore.mockRejectedValue(new Error("still lost"));
		const result = await answerAgentConsent({ oauthQuery: query(), accept: true, orgId: ORG, scopes: ["read"] });
		expect(result.ok).toBe(false);
		expect(h.restore).toHaveBeenCalledWith(SNAPSHOT);
		expect(h.markAnswered).not.toHaveBeenCalled();
	});

	it("is refused without a signed-in person", async () => {
		h.getSession.mockResolvedValue(null);
		const result = await answerAgentConsent({ oauthQuery: query(), accept: false });
		expect(!result.ok && result.error.kind).toBe("unauthenticated");
	});
});
