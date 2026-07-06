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
