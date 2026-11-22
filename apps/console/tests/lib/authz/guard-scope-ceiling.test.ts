// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment node

// `authorizeCli` under a service token's scope ceiling (AGT-L3). The guard is real, and so is the
// ceiling: `getPdp` returns `withScopeCeiling` over an engine that allows everything, so every
// refusal below is the ceiling's. Mocked boundary: the token verifier, scope resolution, the
// membership read, and the activity recorder.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { engine, dbLimit } = vi.hoisted(() => ({
	engine: {
		can: vi.fn(),
		enforce: vi.fn(),
		bulkCheck: vi.fn(),
		listAccessible: vi.fn(),
	},
	dbLimit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/owner", () => ({ getOwnerScope: vi.fn() }));
vi.mock("@/lib/auth/scope", () => ({ getActiveScope: vi.fn() }));
vi.mock("@/lib/authz/actor-context", () => ({ getInjectedActor: vi.fn() }));
vi.mock("@/lib/cli/auth", () => ({ verifyCliToken: vi.fn() }));
vi.mock("@/lib/authz/activity", () => ({
	enforceDecision: vi.fn((_a: unknown, action: Action, resource: ResourceRef, decision: Decision) => {
		if (!decision.allowed) throw new ForbiddenError(action, resource, decision.reason);
	}),
}));
vi.mock("@/lib/authz", async () => {
	const { withScopeCeiling } = await vi.importActual<typeof import("@/lib/authz/scope-ceiling")>(
		"@/lib/authz/scope-ceiling",
	);
	return { getPdp: () => withScopeCeiling(engine) };
});
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		select: () => ({ from: () => ({ where: () => ({ limit: dbLimit }) }) }),
	}),
}));

import { getActiveScope } from "@/lib/auth/scope";
import { authorizeCli } from "@/lib/authz/guard";
import type { Action } from "@/lib/authz/registry";
import { type Decision, ForbiddenError, type ResourceRef } from "@/lib/authz/types";
import { type CliTokenPayload, verifyCliToken } from "@/lib/cli/auth";

const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";
const ALL = ["read", "design", "plan", "apply", "destroy"];

/** A service-token payload pinned to org-A with the given limit fields. */
function tokenPayload(limit: Partial<CliTokenPayload>): CliTokenPayload {
	return {
		sub: "u-minter",
		type: "access",
		service_token_org_id: "org-A",
		service_token_id: "tok-1",
		...limit,
	};
}

/** Authorizes a CLI request carrying `payload` (and an optional org header). */
async function call(
	payload: CliTokenPayload,
	action: Action,
	resource: { type: ResourceRef["type"]; id?: string },
	headerOrg?: string,
) {
	vi.mocked(verifyCliToken).mockResolvedValue({ payload, error: null });
	const headers = new Headers();
	if (headerOrg) headers.set("X-Alethia-Org", headerOrg);
	return authorizeCli(new Request("https://example.test/api/cli", { headers }), action, resource);
}

beforeEach(() => {
	vi.clearAllMocks();
	engine.can.mockResolvedValue({ allowed: true });
	engine.enforce.mockResolvedValue(undefined);
	vi.mocked(getActiveScope).mockImplementation(async (userId: string, orgId?: string) => ({
		userId,
		orgId: orgId ?? userId,
	}));
	// The minter is an active member of org-A.
	dbLimit.mockResolvedValue([{ id: "m-1" }]);
});

describe("a read-only token", () => {
	const READ = tokenPayload({ service_token_scopes: ["read"], service_token_project_ids: null });

	it("gets 403 insufficient_scope on a plan call", async () => {
		const result = await call(READ, "plan", { type: "project", id: PROJECT_A });
		if (!("error" in result)) throw new Error("expected a refusal");
		expect(result.error.status).toBe(403);
		expect(result.error.headers.get("WWW-Authenticate")).toBe('Bearer error="insufficient_scope"');
		expect(await result.error.json()).toMatchObject({
			error: "insufficient_scope",
			reason: "insufficient_scope",
		});
		// The engine was never asked: the ceiling refused first.
		expect(engine.enforce).not.toHaveBeenCalled();
	});

	it("gets 403 insufficient_scope on a deploy, a destroy, and token administration", async () => {
		const cases: [Action, ResourceRef["type"]][] = [
			["deploy", "project"],
			["destroy", "project"],
			["create", "project"],
			["manage_tokens", "org"],
		];
		const served: string[] = [];
		for (const [action, type] of cases) {
			const result = await call(READ, action, { type, id: PROJECT_A });
			if (!("error" in result) || result.error.status !== 403) served.push(action);
		}
		expect(served).toEqual([]);
	});

	it("may read, and the actor it gets carries the ceiling", async () => {
		const result = await call(READ, "view", { type: "project", id: PROJECT_A });
		if ("error" in result) throw new Error("expected an allow");
		expect(result.actor.ceiling).toEqual({ scopes: ["read"], projectIds: null });
		expect(result.actor.credential).toBe("service_token");
	});
});

describe("a token limited to project A", () => {
	const ON_A = tokenPayload({ service_token_scopes: ALL, service_token_project_ids: [PROJECT_A] });

	it("cannot read project B", async () => {
		const result = await call(ON_A, "view", { type: "project", id: PROJECT_B });
		if (!("error" in result)) throw new Error("expected a refusal");
		expect(result.error.status).toBe(403);
		expect(await result.error.json()).toMatchObject({
			error: "insufficient_scope",
			reason: "project_not_permitted",
		});
	});

	it("can read project A", async () => {
		const result = await call(ON_A, "view", { type: "project", id: PROJECT_A });
		expect("error" in result).toBe(false);
	});
});

describe("cross-org", () => {
	it("refuses a header naming another org, whatever the token's scopes", async () => {
		const DEFAULT = tokenPayload({ service_token_scopes: ALL, service_token_project_ids: null });
		const result = await call(DEFAULT, "view", { type: "project", id: PROJECT_A }, "org-B");
		expect("error" in result && result.error.status).toBe(403);
		expect(engine.enforce).not.toHaveBeenCalled();
	});

	it("serves a token only in its pinned org", async () => {
		const DEFAULT = tokenPayload({ service_token_scopes: ALL, service_token_project_ids: null });
		const result = await call(DEFAULT, "view", { type: "org" });
		if ("error" in result) throw new Error("expected an allow");
		expect(result.actor.orgId).toBe("org-A");
	});
});

describe("a token whose limit cannot be read is refused", () => {
	it("refuses no scopes, empty scopes, an unknown scope, and an absent project list", async () => {
		const payloads: CliTokenPayload[] = [
			tokenPayload({ service_token_project_ids: null }),
			tokenPayload({ service_token_scopes: [], service_token_project_ids: null }),
			tokenPayload({ service_token_scopes: ["read", "admin"], service_token_project_ids: null }),
			tokenPayload({ service_token_scopes: ["read"] }),
			tokenPayload({ service_token_scopes: ["read"], service_token_project_ids: [] }),
		];
		const served: number[] = [];
		for (const [i, payload] of payloads.entries()) {
			const result = await call(payload, "view", { type: "org" });
			if (!("error" in result) || result.error.status !== 403) served.push(i);
		}
		expect(served).toEqual([]);
		expect(engine.enforce).not.toHaveBeenCalled();
	});
});

describe("tokens with the default limit keep working", () => {
	const DEFAULT = tokenPayload({ service_token_scopes: ALL, service_token_project_ids: null });

	it("are allowed every verb the engine allows, across projects and administration", async () => {
		const cases: [Action, ResourceRef["type"], string | undefined][] = [
			["view", "project", PROJECT_A],
			["view", "project", PROJECT_B],
			["view", "project", undefined],
			["create", "project", undefined],
			["plan", "project", PROJECT_B],
			["deploy", "project", PROJECT_A],
			["destroy", "project", PROJECT_A],
			["manage_tokens", "org", undefined],
			["view", "job", "not-looked-up"],
		];
		const refused: string[] = [];
		for (const [action, type, id] of cases) {
			const result = await call(DEFAULT, action, { type, id });
			if ("error" in result) refused.push(`${action}:${type}`);
		}
		expect(refused).toEqual([]);
	});

	it("still get the engine's plain 403 when the person lacks the grant", async () => {
		engine.enforce.mockRejectedValue(new ForbiddenError("plan", { type: "project" }, "no_grant"));
		const result = await call(DEFAULT, "plan", { type: "project", id: PROJECT_A });
		if (!("error" in result)) throw new Error("expected a refusal");
		expect(await result.error.json()).toEqual({ error: "Forbidden" });
	});
});

describe("a device-login session has no ceiling", () => {
	it("is authorized by the engine alone", async () => {
		const result = await call({ sub: "u-person", type: "access" }, "manage_tokens", { type: "org" });
		if ("error" in result) throw new Error("expected an allow");
		expect(result.actor.ceiling).toBeUndefined();
	});
});
