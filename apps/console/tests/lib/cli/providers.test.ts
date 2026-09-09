// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cli/auth", () => ({
	verifyCliToken: vi.fn(),
}));

// Cloud connections are org-scoped: resolveCliProvider resolves the actor's scope.
// Stub it so the pure provider-resolution logic stays DB-free in this unit test.
// It MUST honour `activeOrgId`, because which org that argument carries is the whole
// subject of the scoping tests below — a stub that ignored it would return the right
// answer for every one of them and prove nothing.
vi.mock("@/lib/auth/scope", () => ({
	getActiveScope: vi.fn(async (userId: string, activeOrgId?: string) => ({
		userId,
		orgId: activeOrgId ?? userId,
		entitlements: {},
	})),
}));

// The membership predicate itself belongs to `guard.ts` and is tested there; #3863 is
// currently correcting it. What is MINE to prove here is the wiring: that the header is
// put to that check before it is honoured, with the right arguments, and that a denial is
// propagated rather than swallowed. Stubbing it is therefore the point, not a shortcut —
// re-implementing the query here would verify a copy.
vi.mock("@/lib/authz/guard", () => ({
	ensureCliOrgAccess: vi.fn(async () => null),
	// #4298 split the one function in two, because its two callers ask different questions. The
	// service-token branch here asks "is the MINTER still a member", which is the new name; the
	// header branch still asks the credential-aware question. Both are stubbed for the same reason
	// the comment above gives — re-implementing the membership query here would verify a copy.
	assertMintingProfileStillMember: vi.fn(async () => null),
}));

// Hoisted so the factory below can close over it without a TDZ error, and so the test body
// keeps a stable handle on the exact `enforce` the code under test calls.
const pdp = vi.hoisted(() => ({ enforce: vi.fn() }));
vi.mock("@/lib/authz", () => ({ getPdp: () => ({ enforce: pdp.enforce }) }));

import { getActiveScope } from "@/lib/auth/scope";
import {
	assertMintingProfileStillMember,
	ensureCliOrgAccess,
} from "@/lib/authz/guard";
import { ForbiddenError } from "@/lib/authz/types";
import { type CliTokenPayload, verifyCliToken } from "@/lib/cli/auth";
import {
	credentialOf,
	enforceProviderPermission,
	errorResponse,
	isCloudProvider,
	resolveCliProvider,
} from "@/lib/cli/providers";

const mockedVerify = vi.mocked(verifyCliToken);
const mockedEnsure = vi.mocked(ensureCliOrgAccess);
const mockedMinterCheck = vi.mocked(assertMintingProfileStillMember);
const mockedScope = vi.mocked(getActiveScope);

function req(headers?: Record<string, string>) {
	return new Request("http://localhost/api/cli/providers/aws/init", { headers });
}

beforeEach(() => {
	// clearAllMocks resets call records but KEEPS implementations, so the org-honouring
	// getActiveScope stub declared in the factory above stays in force for every test.
	vi.clearAllMocks();
	mockedEnsure.mockResolvedValue(null);
	mockedMinterCheck.mockResolvedValue(null);
	pdp.enforce.mockResolvedValue(undefined);
});

describe("isCloudProvider", () => {
	it("accepts the supported providers", () => {
		expect(isCloudProvider("aws")).toBe(true);
		expect(isCloudProvider("gcp")).toBe(true);
		expect(isCloudProvider("azure")).toBe(true);
	});

	it("rejects anything else", () => {
		expect(isCloudProvider("kubernetes")).toBe(false);
		expect(isCloudProvider("AWS")).toBe(false);
		expect(isCloudProvider("")).toBe(false);
	});
});

describe("errorResponse", () => {
	it("maps an Error to a 400 JSON response", async () => {
		const resp = errorResponse(new Error("boom"));
		expect(resp.status).toBe(400);
		expect(await resp.json()).toEqual({ error: "boom" });
	});

	it("respects a custom status", () => {
		expect(errorResponse(new Error("nope"), 500).status).toBe(500);
	});

	it("falls back to a generic message for non-Error values", async () => {
		const resp = errorResponse("weird", 500);
		expect(await resp.json()).toEqual({ error: "Internal Server Error" });
	});
});

describe("resolveCliProvider", () => {
	it("propagates the auth error response when the token is invalid", async () => {
		mockedVerify.mockResolvedValue({
			payload: null,
			error: new Response(JSON.stringify({ error: "Unauthorized" }), {
				status: 401,
			}),
		});

		const result = await resolveCliProvider(
			req(),
			Promise.resolve({ provider: "aws" }),
		);
		expect(result.userId).toBeNull();
		expect(result.provider).toBeNull();
		expect(result.errorResponse?.status).toBe(401);
	});

	it("returns 400 for an unsupported provider", async () => {
		mockedVerify.mockResolvedValue({
			payload: { sub: "user-123" },
			error: null,
		});

		const result = await resolveCliProvider(
			req(),
			Promise.resolve({ provider: "kubernetes" }),
		);
		expect(result.userId).toBeNull();
		expect(result.errorResponse?.status).toBe(400);
	});

	it("resolves the user id and typed provider for a valid request", async () => {
		mockedVerify.mockResolvedValue({
			payload: { sub: "user-123" },
			error: null,
		});

		const result = await resolveCliProvider(
			req(),
			Promise.resolve({ provider: "gcp" }),
		);
		expect(result.errorResponse).toBeNull();
		expect(result.userId).toBe("user-123");
		expect(result.provider).toBe("gcp");
		expect(result.scope).toEqual({
			userId: "user-123",
			orgId: "user-123",
			entitlements: {},
		});
	});

	it("returns 401 when the payload has no subject", async () => {
		mockedVerify.mockResolvedValue({
			payload: {},
			error: null,
		});

		const result = await resolveCliProvider(
			req(),
			Promise.resolve({ provider: "aws" }),
		);
		expect(result.errorResponse?.status).toBe(401);
	});
});

/**
 * These five routes are the only `/api/cli/*` surface that RESOLVES ITS OWN ORG SCOPE without
 * going through `authorizeCli`, so the `X-Alethia-Org` handling that guard owns is mirrored in
 * `resolveCliProvider` rather than inherited. The `repositories/{github,gitlab,bitbucket}` routes
 * also bypass the guard, and are exempt because they resolve no scope at all — see the note beside
 * the check itself. Before this, the header was accepted by the CLI and silently dropped here: the
 * operator named org B and the call answered about org A.
 */
describe("resolveCliProvider — organization scoping", () => {
	const human = { payload: { sub: "user-123" }, error: null };

	it("honours X-Alethia-Org once membership is confirmed", async () => {
		mockedVerify.mockResolvedValue(human);

		const result = await resolveCliProvider(
			req({ "X-Alethia-Org": "org-B" }),
			Promise.resolve({ provider: "aws" }),
		);

		expect(result.errorResponse).toBeNull();
		expect(result.scope?.orgId).toBe("org-B");
		// The membership check ran, against the DEFAULT scope and the named org — not against
		// the org it is being asked to authorise, which would be circular.
		expect(mockedEnsure).toHaveBeenCalledTimes(1);
		expect(mockedEnsure).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "user-123", orgId: "user-123" }),
			// The CREDENTIAL, not a userId, since #4298 — and `"session"` is the arm that keeps the
			// membership query. A token reaching this call would be the defect.
			"session",
			"org-B",
		);
	});

	it("refuses a header naming an organization the caller does not belong to", async () => {
		mockedVerify.mockResolvedValue(human);
		mockedEnsure.mockResolvedValue(
			new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
		);

		const result = await resolveCliProvider(
			req({ "X-Alethia-Org": "org-not-mine" }),
			Promise.resolve({ provider: "aws" }),
		);

		expect(result.errorResponse?.status).toBe(403);
		// Fail CLOSED: no scope escapes alongside the denial for a caller to use by mistake.
		expect(result.scope).toBeNull();
		expect(result.userId).toBeNull();
		expect(result.provider).toBeNull();
	});

	it("falls back to the active organization when the header is absent", async () => {
		mockedVerify.mockResolvedValue(human);

		const result = await resolveCliProvider(
			req(),
			Promise.resolve({ provider: "aws" }),
		);

		expect(result.scope?.orgId).toBe("user-123");
		expect(mockedEnsure).not.toHaveBeenCalled();
	});

	it("treats a whitespace-only header as absent rather than as an org named \" \"", async () => {
		mockedVerify.mockResolvedValue(human);

		const result = await resolveCliProvider(
			req({ "X-Alethia-Org": "   " }),
			Promise.resolve({ provider: "aws" }),
		);

		expect(result.errorResponse).toBeNull();
		expect(result.scope?.orgId).toBe("user-123");
		expect(mockedEnsure).not.toHaveBeenCalled();
	});

	// These two used to assert `expect(mockedEnsure).not.toHaveBeenCalled()` and were NAMED
	// "with no membership check here". They pinned the defect: a token kept working after the
	// profile that minted it was removed from the org (#4041).
	it("pins a service token to its own organization, AFTER re-checking the minter's membership", async () => {
		mockedVerify.mockResolvedValue({
			payload: { sub: "user-123", service_token_org_id: "org-svc" },
			error: null,
		});

		const result = await resolveCliProvider(
			req(),
			Promise.resolve({ provider: "aws" }),
		);

		expect(result.scope?.orgId).toBe("org-svc");
		// The DEFAULT scope is what goes in, never one resolved from the pin — see the comment
		// in providers.ts. The function short-circuits on `actor.orgId === orgId`, so passing the
		// pinned scope would compare the pin to itself and skip the query entirely.
		//
		// `assertMintingProfileStillMember` since #4298, and the RENAME IS THE POINT: this branch
		// never asked the credential-aware question, and calling the same function as the header
		// branch is what made a token arm look safe to add to it.
		expect(mockedMinterCheck).toHaveBeenCalledWith(
			expect.objectContaining({ orgId: "user-123" }),
			"org-svc",
		);
		expect(mockedEnsure).not.toHaveBeenCalled();
	});

	it("lets the service token's pin win over a header, never the other way round", async () => {
		mockedVerify.mockResolvedValue({
			payload: { sub: "user-123", service_token_org_id: "org-svc" },
			error: null,
		});

		const result = await resolveCliProvider(
			req({ "X-Alethia-Org": "org-svc" }),
			Promise.resolve({ provider: "aws" }),
		);

		expect(result.scope?.orgId).toBe("org-svc");
		// Checked against the PIN, not the header — the header is not consulted on this branch.
		expect(mockedMinterCheck).toHaveBeenCalledWith(
			expect.anything(),
			"org-svc",
		);
	});

	// THE DELIVERABLE OF #4041, and it is written to fail for the right reason.
	//
	// A missing grant, a bad token and a revoked membership all answer 403, and only one of
	// them is this. So the assertions are: the membership check RAN with the pinned org, the
	// refusal it produced is the one returned, no scope escapes alongside it, and the pinned
	// scope was never resolved — a 403 handed back beside a usable scope is the substitution
	// this exists to prevent, not a refusal.
	it("refuses a service token whose minter is no longer a member of the pinned org", async () => {
		mockedVerify.mockResolvedValue({
			payload: { sub: "user-123", service_token_org_id: "org-svc" },
			error: null,
		});
		mockedMinterCheck.mockResolvedValue(
			new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
		);

		const result = await resolveCliProvider(
			req(),
			Promise.resolve({ provider: "aws" }),
		);

		expect(mockedMinterCheck).toHaveBeenCalledWith(
			expect.objectContaining({ orgId: "user-123" }),
			"org-svc",
		);
		expect(result.errorResponse?.status).toBe(403);
		expect(result.scope).toBeNull();
		expect(result.userId).toBeNull();
		expect(result.provider).toBeNull();
		// The pin was never resolved into a scope: only the default resolution happened.
		expect(mockedScope).not.toHaveBeenCalledWith("user-123", "org-svc");
		// And nothing reached the PDP — a permission denial would be a different failure.
		expect(pdp.enforce).not.toHaveBeenCalled();
	});

	it("propagates the 403 verifyCliToken raises for a CONFLICTING service-token header", async () => {
		// The refusal itself lives at the chokepoint (lib/cli/auth.ts) so that every route gets
		// it, including this one. What this asserts is that the refusal is RETURNED here rather
		// than resolved past — a silently rescoped pipeline is the failure mode being prevented.
		mockedVerify.mockResolvedValue({
			payload: null,
			error: new Response(
				JSON.stringify({
					error: "Forbidden: this service token is scoped to a different organization",
				}),
				{ status: 403 },
			),
		});

		const result = await resolveCliProvider(
			req({ "X-Alethia-Org": "org-other" }),
			Promise.resolve({ provider: "aws" }),
		);

		expect(result.errorResponse?.status).toBe(403);
		expect(result.scope).toBeNull();
	});
});

/**
 * `credentialOf` — the one derivation of the credential KIND (#4468).
 *
 * Both files that resolve their own CLI scope used to re-infer the kind from whether
 * `service_token_org_id` was a non-empty string, and they DISAGREED about the empty case: this
 * module turned `""` into `undefined` (⇒ a human), `app/api/jobs/route.ts` kept it as `""` (⇒ a
 * pin that is not one, and a `??` that does not fall back). Neither answer is safe, so the third
 * one is asserted here: refuse.
 *
 * These are unit assertions on a pure function BECAUSE the callers cannot reach every input. The
 * pin comes from `cli_service_tokens.organization_id`, which is `uuid().notNull()`, so no request
 * that exists today produces the blank or non-string cases. What makes them worth pinning is that
 * the constraint keeping them unreachable is two files away and can be relaxed by an author who
 * never reads this one, while `CliTokenPayload` already declares the field optional.
 */
describe("credentialOf", () => {
	it("reads an absent pin as a session, with no org of its own", () => {
		expect(credentialOf({ sub: "user-123" })).toEqual({
			credential: "session",
			pinnedOrg: null,
		});
	});

	it("reads a real pin as a service token and carries it on the same value", () => {
		expect(credentialOf({ sub: "user-123", service_token_org_id: "org-svc" })).toEqual({
			credential: "service_token",
			pinnedOrg: "org-svc",
		});
	});

	// The whole reason the return type is nullable. `""` is not "no pin" and it is not a pin: a
	// credential that cannot say which org it is for is not a credential.
	it("REFUSES a blank pin rather than reading it as either kind", () => {
		expect(credentialOf({ sub: "user-123", service_token_org_id: "" })).toBeNull();
		expect(credentialOf({ sub: "user-123", service_token_org_id: "   " })).toBeNull();
	});

	// `CliTokenPayload extends jose.JWTPayload`, whose index signature makes the `?: string`
	// declaration a claim about the writer rather than a check on the reader. A JSON `null` and a
	// number both type-check their way in through it at runtime.
	it("REFUSES a pin that is not a string", () => {
		// Built by PARSING JSON, which is how a payload actually reaches this function — and the
		// only way to produce the shapes `service_token_org_id?: string` denies at compile time
		// without an `as` cast, which the code style bans outright.
		const parsed = (raw: string): CliTokenPayload => JSON.parse(raw);
		expect(credentialOf(parsed('{"sub":"u","service_token_org_id":null}'))).toBeNull();
		expect(credentialOf(parsed('{"sub":"u","service_token_org_id":7}'))).toBeNull();
	});

	// Unreachable from either caller — both establish `payload.sub` first — and refused anyway,
	// because the alternative is writing "absent ⇒ human" into the one function whose job is to
	// stop that sentence existing.
	it("refuses a missing payload rather than calling it a session", () => {
		expect(credentialOf(undefined)).toBeNull();
		expect(credentialOf(null)).toBeNull();
	});
});

/**
 * The refusal, driven through the route resolver rather than the pure function — because the
 * failure being prevented is not "returns the wrong tuple", it is "resolves a SCOPE for a
 * credential whose org is unreadable". Before #4468 this input took the session path and
 * `getActiveScope(userId)` answered with the MINTER'S DEFAULT ORG, which is somebody's session
 * state standing in for a machine's tenancy.
 */
describe("resolveCliProvider — a malformed pin", () => {
	it("401s and resolves NO scope when the pin is present but blank", async () => {
		mockedVerify.mockResolvedValue({
			payload: { sub: "user-123", service_token_org_id: "" },
			error: null,
		});

		const result = await resolveCliProvider(
			req(),
			Promise.resolve({ provider: "aws" }),
		);

		expect(result.errorResponse?.status).toBe(401);
		expect(result.scope).toBeNull();
		// The assertion that separates "refused" from "refused, having already computed the wrong
		// answer": no org was resolved at all, by either arm.
		expect(mockedScope).not.toHaveBeenCalled();
		expect(mockedEnsure).not.toHaveBeenCalled();
		expect(mockedMinterCheck).not.toHaveBeenCalled();
	});
});

describe("enforceProviderPermission", () => {
	// `entitlements` is optional on Actor; the PDP decision under test reads only orgId.
	const actor = { userId: "user-123", orgId: "org-B" };

	it("returns null when the PDP allows the action", async () => {
		expect(
			await enforceProviderPermission(actor, "manage_identities", {
				type: "cloud_identity",
			}),
		).toBeNull();
	});

	it("decides in the org the call was SCOPED to, not a re-resolved default", async () => {
		await enforceProviderPermission(actor, "manage_identities", {
			type: "cloud_identity",
		});

		// The escalation this replaced `authorizeUserId` to prevent: PostgresRbacPDP filters
		// grants by `g.org_id = actor.orgId`, so enforcing against the default org would let an
		// owner of org A act as one in org B. The subject must be the actor it was handed.
		expect(pdp.enforce).toHaveBeenCalledWith(
			expect.objectContaining({ orgId: "org-B" }),
			"manage_identities",
			{ type: "cloud_identity", id: undefined },
		);
		// And it must not go behind that actor's back to resolve another one.
		expect(mockedScope).not.toHaveBeenCalled();
	});

	it("maps a ForbiddenError to a 403 in the guard's own shape", async () => {
		pdp.enforce.mockRejectedValue(
			new ForbiddenError("view", { type: "cloud_identity" }),
		);

		const denied = await enforceProviderPermission(actor, "view", {
			type: "cloud_identity",
		});

		expect(denied?.status).toBe(403);
		expect(await denied?.json()).toEqual({ error: "Forbidden" });
	});

	it("rethrows anything that is not a ForbiddenError", async () => {
		// A database outage must not be reported as a denial: "you may not" and "we could not
		// tell" are different answers, and collapsing them hides an outage behind a 403.
		pdp.enforce.mockRejectedValue(new Error("connection terminated"));

		await expect(
			enforceProviderPermission(actor, "view", { type: "cloud_identity" }),
		).rejects.toThrow("connection terminated");
	});
});

/**
 * The scope and the permission decision have to move together. Asserting it structurally
 * because the alternative — five route-level tests standing up `conn.*`, the wire validators
 * and the PDP — would test the mocks more than the wiring, and the thing that can regress is
 * exactly one line per route: which actor the enforcement is handed.
 */
describe("the provider routes enforce in the resolved scope", () => {
	const routes = ["init", "connect", "status", "verify", "disconnect"];
	const dir = join(
		dirname(fileURLToPath(import.meta.url)),
		"../../../app/api/cli/providers/[provider]",
	);

	it("reads all five route files", () => {
		// Guards that report green on an empty set are the dominant defect class here: if this
		// path ever stops resolving, every assertion below would pass vacuously.
		for (const r of routes) {
			expect(readFileSync(join(dir, r, "route.ts"), "utf8").length).toBeGreaterThan(0);
		}
	});

	for (const r of routes) {
		it(`${r} enforces against \`scope\`, not a default-org actor`, () => {
			const src = readFileSync(join(dir, r, "route.ts"), "utf8");
			expect(src).toContain("enforceProviderPermission(scope,");
			// authorizeUserId resolves getActiveScope(userId) with no org — putting it back
			// would silently restore the cross-org escalation.
			expect(src).not.toContain("authorizeUserId");
		});
	}
});
