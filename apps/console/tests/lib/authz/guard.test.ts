// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The REAL authorization guard (lib/authz/guard.ts). Mocked boundary: the PDP (getPdp),
// scope/owner resolution, the injected-actor seam, and the CLI token verifier. Asserts
// the actor-resolution precedence (injected > session), the personal-scope fallback,
// enforce/can wiring + arguments, and every ForbiddenError → 403 branch.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/owner", () => ({ getOwnerScope: vi.fn() }));
vi.mock("@/lib/auth/scope", () => ({ getActiveScope: vi.fn() }));
vi.mock("@/lib/authz", () => ({ getPdp: vi.fn() }));
vi.mock("@/lib/authz/actor-context", () => ({ getInjectedActor: vi.fn() }));
vi.mock("@/lib/cli/auth", () => ({ verifyCliToken: vi.fn() }));

// `isOrgMember` reads the `member` table, and the service-token branch below calls it on EVERY
// request. vi.hoisted because the factory is hoisted above every const in this file.
const { dbLimit } = vi.hoisted(() => ({ dbLimit: vi.fn() }));
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: dbLimit }) }) }) }),
}));

import { getOwnerScope } from "@/lib/auth/owner";
import { getActiveScope } from "@/lib/auth/scope";
import { getPdp } from "@/lib/authz";
import { getInjectedActor } from "@/lib/authz/actor-context";
import { verifyCliToken } from "@/lib/cli/auth";
import { ForbiddenError, type Actor } from "@/lib/authz/types";

import {
	authorize,
	authorizeCli,
	authorizeQuiet,
	authorizeUserId,
	currentActor,
} from "@/lib/authz/guard";

const SESSION_ACTOR: Actor = { userId: "u-session", orgId: "org-session" };
const INJECTED_ACTOR: Actor = { userId: "u-mcp", orgId: "org-mcp" };
const CLI_ACTOR: Actor = { userId: "u-cli", orgId: "org-cli" };

const enforce = vi.fn();
const can = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	// Default PDP: allows everything.
	enforce.mockResolvedValue(undefined);
	can.mockResolvedValue({ allowed: true });
	vi.mocked(getPdp).mockReturnValue({
		enforce,
		can,
		bulkCheck: vi.fn(),
		listAccessible: vi.fn(),
	});
	// Default: no injected actor → session resolution path.
	vi.mocked(getInjectedActor).mockReturnValue(undefined);
	vi.mocked(getOwnerScope).mockResolvedValue({
		userId: "u-session",
		activeOrgId: "org-session",
	} as never);
	vi.mocked(getActiveScope).mockResolvedValue(SESSION_ACTOR);
});

describe("currentActor", () => {
	it("returns the injected actor without touching session resolution", async () => {
		vi.mocked(getInjectedActor).mockReturnValue(INJECTED_ACTOR);

		const actor = await currentActor();

		expect(actor).toBe(INJECTED_ACTOR);
		expect(getOwnerScope).not.toHaveBeenCalled();
		expect(getActiveScope).not.toHaveBeenCalled();
	});

	it("resolves from owner scope → getActiveScope(userId, activeOrgId) when not injected", async () => {
		const actor = await currentActor();

		expect(actor).toBe(SESSION_ACTOR);
		expect(getOwnerScope).toHaveBeenCalledTimes(1);
		expect(getActiveScope).toHaveBeenCalledWith("u-session", "org-session");
	});

	it("passes through an undefined activeOrgId (personal-scope fallback)", async () => {
		vi.mocked(getOwnerScope).mockResolvedValue({
			userId: "u-personal",
			activeOrgId: undefined,
		} as never);
		const personal: Actor = { userId: "u-personal", orgId: "u-personal" };
		vi.mocked(getActiveScope).mockResolvedValue(personal);

		const actor = await currentActor();

		// Personal org === userId in community.
		expect(actor.orgId).toBe(actor.userId);
		expect(getActiveScope).toHaveBeenCalledWith("u-personal", undefined);
	});
});

describe("authorize", () => {
	it("resolves the actor, enforces the verb with the exact ResourceRef, and returns the actor", async () => {
		const actor = await authorize("manage_connectors", { type: "connector", id: "c-1" });

		expect(actor).toBe(SESSION_ACTOR);
		expect(enforce).toHaveBeenCalledWith(SESSION_ACTOR, "manage_connectors", {
			type: "connector",
			id: "c-1",
		});
		expect(can).not.toHaveBeenCalled();
	});

	it("omits id (undefined) for create/list-style refs", async () => {
		await authorize("manage_connectors", { type: "connector" });

		expect(enforce).toHaveBeenCalledWith(SESSION_ACTOR, "manage_connectors", {
			type: "connector",
			id: undefined,
		});
	});

	it("propagates ForbiddenError from the PDP", async () => {
		const denial = new ForbiddenError("manage_connectors", { type: "connector" }, "no_grant");
		enforce.mockRejectedValueOnce(denial);

		await expect(authorize("manage_connectors", { type: "connector" })).rejects.toBe(denial);
	});
});

describe("authorizeQuiet", () => {
	it("uses can() (never enforce) and returns the actor when allowed", async () => {
		const actor = await authorizeQuiet("manage_connectors", { type: "connector", id: "c-2" });

		expect(actor).toBe(SESSION_ACTOR);
		expect(can).toHaveBeenCalledWith(SESSION_ACTOR, "manage_connectors", {
			type: "connector",
			id: "c-2",
		});
		expect(enforce).not.toHaveBeenCalled();
	});

	it("throws ForbiddenError (carrying the decision reason) when denied", async () => {
		can.mockResolvedValueOnce({ allowed: false, reason: "no_grant" });

		const err = await authorizeQuiet("manage_connectors", { type: "connector", id: "c-3" }).catch(
			(e) => e,
		);

		expect(err).toBeInstanceOf(ForbiddenError);
		expect(err.reason).toBe("no_grant");
		expect(err.action).toBe("manage_connectors");
		expect(err.resource).toEqual({ type: "connector", id: "c-3" });
	});
});

describe("authorizeCli", () => {
	const req = new Request("https://example.test/api/cli");

	it("returns the verifier's error Response when the token is invalid", async () => {
		const errorResponse = new Response("nope", { status: 401 });
		vi.mocked(verifyCliToken).mockResolvedValue({ payload: null, error: errorResponse } as never);

		const result = await authorizeCli(req, "manage_connectors", { type: "connector" });

		expect(result).toEqual({ error: errorResponse });
		expect("actor" in result).toBe(false);
		expect(getActiveScope).not.toHaveBeenCalled();
	});

	it("returns a 400 Response when the token payload has no subject", async () => {
		vi.mocked(verifyCliToken).mockResolvedValue({ payload: {}, error: undefined } as never);

		const result = await authorizeCli(req, "manage_connectors", { type: "connector" });

		expect("error" in result).toBe(true);
		const { error } = result as { error: Response };
		expect(error.status).toBe(400);
		await expect(error.json()).resolves.toEqual({ error: "Invalid token payload" });
	});

	it("resolves the actor from the token sub, enforces, and returns the actor", async () => {
		vi.mocked(verifyCliToken).mockResolvedValue({
			payload: { sub: "u-cli" },
			error: undefined,
		} as never);
		vi.mocked(getActiveScope).mockResolvedValue(CLI_ACTOR);

		const result = await authorizeCli(req, "manage_connectors", { type: "connector", id: "c-9" });

		expect(getActiveScope).toHaveBeenCalledWith("u-cli");
		expect(enforce).toHaveBeenCalledWith(CLI_ACTOR, "manage_connectors", {
			type: "connector",
			id: "c-9",
		});
		expect(result).toEqual({ actor: CLI_ACTOR });
	});

	it("maps a ForbiddenError to a 403 Response", async () => {
		vi.mocked(verifyCliToken).mockResolvedValue({
			payload: { sub: "u-cli" },
			error: undefined,
		} as never);
		vi.mocked(getActiveScope).mockResolvedValue(CLI_ACTOR);
		enforce.mockRejectedValueOnce(
			new ForbiddenError("manage_connectors", { type: "connector" }, "no_grant"),
		);

		const result = await authorizeCli(req, "manage_connectors", { type: "connector" });

		expect("error" in result).toBe(true);
		const { error } = result as { error: Response };
		expect(error.status).toBe(403);
		await expect(error.json()).resolves.toEqual({ error: "Forbidden" });
	});

	it("rethrows non-Forbidden errors", async () => {
		vi.mocked(verifyCliToken).mockResolvedValue({
			payload: { sub: "u-cli" },
			error: undefined,
		} as never);
		vi.mocked(getActiveScope).mockResolvedValue(CLI_ACTOR);
		const boom = new Error("pdp down");
		enforce.mockRejectedValueOnce(boom);

		await expect(authorizeCli(req, "manage_connectors", { type: "connector" })).rejects.toBe(boom);
	});
});

// ── SERVICE-ACCOUNT TOKENS: the organization pin. ──
//
// A service token's org is fixed when it is minted. An interactive session picks its org with an
// `X-Alethia-Org` header, which is safe because a human's own memberships bound it; a machine
// credential has no human behind it, so honouring that header would let a token issued to one tenant
// act on another. CLI routes query via getServiceDb() with NO RLS beneath them, so this branch IS the
// tenancy boundary for anything driven from a pipeline.
//
// Asserted here as BEHAVIOUR rather than as source text: the Go-side equivalent was caught by the
// anti-vacuity tripwire for scanning source and executing none of the code, and this is the same
// property on the other side of the wire.
describe("authorizeCli with a service-account token", () => {
	const SERVICE_ACTOR: Actor = { userId: "u-minter", orgId: "org-A" };

	/** A request carrying a service-token payload, optionally scoped by an org header. */
	function serviceReq(headerOrg?: string): Request {
		const headers = new Headers();
		if (headerOrg) headers.set("X-Alethia-Org", headerOrg);
		return new Request("https://example.test/api/cli", { headers });
	}

	beforeEach(() => {
		vi.mocked(verifyCliToken).mockResolvedValue({
			payload: { sub: "u-minter", type: "access", service_token_org_id: "org-A", service_token_id: "tok-1" },
			error: undefined,
		} as never);
		vi.mocked(getActiveScope).mockResolvedValue(SERVICE_ACTOR);
		// The minting profile is a member of org-A by default.
		dbLimit.mockResolvedValue([{ id: "m-1" }]);
	});

	it("scopes to the token's own org when no header is sent", async () => {
		const result = await authorizeCli(serviceReq(), "manage_tokens", { type: "org" });

		// The PINNED org, not `getActiveScope(userId)` — which would resolve whichever org that
		// PERSON last had active, i.e. somebody's session state standing in for a machine's scope.
		expect(getActiveScope).toHaveBeenCalledWith("u-minter", "org-A");
		expect(result).toEqual({ actor: SERVICE_ACTOR });
	});

	it("accepts a header that AGREES with the token's org", async () => {
		const result = await authorizeCli(serviceReq("org-A"), "manage_tokens", { type: "org" });

		expect(getActiveScope).toHaveBeenCalledWith("u-minter", "org-A");
		expect(result).toEqual({ actor: SERVICE_ACTOR });
	});

	// THE ONE THAT MATTERS. Refused, never ignored: ignoring it would let a pipeline believe it is
	// writing to org B while every write lands in org A — a wrong answer that looks like a right one.
	it("REFUSES a header naming a different org, and resolves no scope at all", async () => {
		const result = await authorizeCli(serviceReq("org-B"), "manage_tokens", { type: "org" });

		expect("error" in result).toBe(true);
		expect((result as { error: Response }).error.status).toBe(403);
		expect(getActiveScope).not.toHaveBeenCalled();
		expect(enforce).not.toHaveBeenCalled();
	});

	// Membership is re-checked on EVERY request rather than trusted from mint time — otherwise
	// revoking somebody's access would leave their tokens live, which is the offboarding hole
	// long-lived credentials are known for.
	it("REFUSES when the minting profile is no longer a member of the token's org", async () => {
		dbLimit.mockResolvedValue([]);

		const result = await authorizeCli(serviceReq(), "manage_tokens", { type: "org" });

		expect("error" in result).toBe(true);
		expect((result as { error: Response }).error.status).toBe(403);
		expect(enforce).not.toHaveBeenCalled();
	});

	// The pin decides SCOPE; it does not grant permission. The PDP still rules on the action, and a
	// denial is a 403 like any other — a service token is not a way around authorization.
	it("still defers to the PDP, mapping a ForbiddenError to 403", async () => {
		enforce.mockRejectedValueOnce(
			new ForbiddenError("manage_tokens", { type: "org" }, "no_grant"),
		);

		const result = await authorizeCli(serviceReq(), "manage_tokens", { type: "org" });

		expect("error" in result).toBe(true);
		expect((result as { error: Response }).error.status).toBe(403);
	});

	it("rethrows a non-Forbidden PDP error rather than turning it into a denial", async () => {
		const boom = new Error("pdp down");
		enforce.mockRejectedValueOnce(boom);

		await expect(authorizeCli(serviceReq(), "manage_tokens", { type: "org" })).rejects.toBe(boom);
	});
});

describe("authorizeUserId", () => {
	it("resolves the actor, enforces, and returns null when allowed", async () => {
		vi.mocked(getActiveScope).mockResolvedValue(CLI_ACTOR);

		const result = await authorizeUserId("u-cli", "manage_connectors", {
			type: "connector",
			id: "c-7",
		});

		expect(result).toBeNull();
		expect(getActiveScope).toHaveBeenCalledWith("u-cli");
		expect(enforce).toHaveBeenCalledWith(CLI_ACTOR, "manage_connectors", {
			type: "connector",
			id: "c-7",
		});
	});

	it("returns a 403 Response on ForbiddenError", async () => {
		vi.mocked(getActiveScope).mockResolvedValue(CLI_ACTOR);
		enforce.mockRejectedValueOnce(
			new ForbiddenError("manage_connectors", { type: "connector" }, "no_grant"),
		);

		const result = await authorizeUserId("u-cli", "manage_connectors", { type: "connector" });

		expect(result).not.toBeNull();
		expect(result?.status).toBe(403);
		await expect(result?.json()).resolves.toEqual({ error: "Forbidden" });
	});

	it("rethrows non-Forbidden errors", async () => {
		vi.mocked(getActiveScope).mockResolvedValue(CLI_ACTOR);
		const boom = new Error("pdp down");
		enforce.mockRejectedValueOnce(boom);

		await expect(
			authorizeUserId("u-cli", "manage_connectors", { type: "connector" }),
		).rejects.toBe(boom);
	});
});
