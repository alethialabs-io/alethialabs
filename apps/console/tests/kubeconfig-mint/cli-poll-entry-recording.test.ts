// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #5670: the CLI kubeconfig mint POLL's entry gate must not write an activity row per poll, and must
// refuse exactly whom it refused before.
//
// Before the fix `GET /api/cli/clusters/:id/kubeconfig/:mintId` authorized every poll with the
// recording `authorizeCli(req, "access_readonly", …)`. `access_readonly` is not a read action
// (lib/authz/activity.ts READ_ONLY), so `enforceDecision` wrote one `authz_activity_log` row per poll —
// one every two seconds for as long as `alethia` waited on a mint. #5668 (#5667) fixed the admin
// re-check on the same path; this is the entry gate in front of it.
//
// Nothing about authorization is stubbed here that the fix touches: the REAL route, the REAL
// lib/authz/guard.ts (`authorizeCli` and `authorizeCliQuiet`, token pin, header, membership
// re-check, scope resolution), the REAL `PostgresRbacPDP.enforce` → `enforceDecision` →
// `recordActivity`, and the real poll/gates. Stubbed: the token verifier (by token string), the
// grant lookup `can` (by org + action), scope resolution, the member lookup's answer, the DB handles
// (one RLS transaction holding a pending mint; the service handle so the activity INSERT is
// observable), the action-event emitter, and — for the POST only — the mint writer and limiter.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Resource } from "@/lib/authz/registry";
import type { CliTokenPayload } from "@/lib/cli/auth";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const CLUSTER = "44444444-4444-4444-8444-444444444444";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const TOKEN_ID = "66666666-6666-4666-8666-666666666666";
const MINT = "77777777-7777-4777-8777-777777777777";
const JOB = "88888888-8888-4888-8888-888888888888";
const KEY = "Qw9LmFlmUUWmsbonQCRIe9ZvA6LdV313U8aNfX0AwAw";
const EXPIRES = new Date("2026-10-01T12:10:00.000Z");

/** Every row handed to `insert(authz_activity_log).values(...)` on the service handle. */
let activityRows: Record<string, unknown>[] = [];
/** The `${orgId}:${action}` grants the stubbed `can` allows. */
let grants = new Set<string>();
/** What the guard's ACTIVE-member lookup answers (the offboarding re-check, the header check). */
let isMember = true;
/** Whether scope resolution honours the named org, or falls back to some other org of the user's. */
let resolverHonoursNamedOrg = true;
/** How many times the poll opened the RLS transaction — i.e. read the mint at all. */
let mintReads = 0;

/** The RLS transaction: one pending READ-ONLY mint, so the admin re-check (#5667) never runs. */
const fakeTx = {
	select: () => {
		const chain = {
			from: () => chain,
			innerJoin: () => chain,
			leftJoin: () => chain,
			where: () => chain,
			limit: async () => [
				{
					status: "pending",
					tier: "readonly",
					shape: "exec",
					ttl_seconds: 3600,
					job_id: JOB,
					failure_reason: null,
					private_endpoint: false,
					expires_at: EXPIRES,
					expired_now: false,
					project_id: PROJECT,
					job_status: "PROCESSING",
				},
			],
		};
		return chain;
	},
	delete: () => ({ where: () => ({ returning: async () => [] }) }),
	insert: () => ({ values: async () => undefined }),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", async () => {
	const { authzActivityLog } = await import("@/lib/db/schema");
	return {
		withActorScope: async (_actor: unknown, fn: (tx: typeof fakeTx) => Promise<unknown>) => {
			mintReads += 1;
			return fn(fakeTx);
		},
		getServiceDb: () => ({
			insert: (table: unknown) => ({
				values: (v: Record<string, unknown>) => {
					if (table === authzActivityLog) activityRows.push(v);
					return { catch: () => undefined };
				},
			}),
			select: () => ({
				from: () => ({
					where: () => ({ limit: async () => (isMember ? [{ id: "m-1" }] : []) }),
				}),
			}),
		}),
	};
});
vi.mock("@/lib/cli/auth", () => ({ verifyCliToken: vi.fn() }));
vi.mock("@/lib/auth/scope", () => ({ getActiveScope: vi.fn() }));
vi.mock("@/lib/auth/owner", () => ({ getOwnerScope: vi.fn() }));
vi.mock("@/lib/authz/actor-context", () => ({ getInjectedActor: vi.fn() }));
vi.mock("@/lib/authz/org-scope", () => ({ urlScopedOrgId: vi.fn() }));
vi.mock("@/lib/authz", () => ({ getPdp: vi.fn() }));
vi.mock("@/lib/alerts/emit", () => ({ emitActionEvent: vi.fn() }));
vi.mock("@/lib/rate-limit", async () =>
	(await import("@/tests/fixtures/memory-rate-limit")).memoryRateLimitModule(),
);
vi.mock("@/lib/kubeconfig-mint/request", () => ({ requestKubeconfigMint: vi.fn() }));
vi.mock("@/lib/auth/trusted-ip", () => ({ trustedClientIp: vi.fn(() => "198.51.100.4") }));
vi.mock("@/lib/observability/log", () => {
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };
	return { log: logger };
});

import { GET } from "@/app/api/cli/clusters/[id]/kubeconfig/[mintId]/route";
import { POST } from "@/app/api/cli/clusters/[id]/kubeconfig/route";
import { emitActionEvent } from "@/lib/alerts/emit";
import { getActiveScope } from "@/lib/auth/scope";
import { getPdp } from "@/lib/authz";
import { authorizeCli, authorizeCliQuiet } from "@/lib/authz/guard";
import { PostgresRbacPDP } from "@/lib/authz/postgres-rbac-pdp";
import { verifyCliToken } from "@/lib/cli/auth";
import { requestKubeconfigMint } from "@/lib/kubeconfig-mint/request";

/** The bearer strings the stubbed verifier understands. */
const SESSION = "session-jwt";
const SERVICE = "alethia_svc_live";
const REVOKED = "alethia_svc_revoked";
const NO_SUB = "jwt-without-subject";

/** What the real verifier answers for each bearer; an absent or unknown one is a 401. */
function verdict(req: Request): Awaited<ReturnType<typeof verifyCliToken>> {
	const bearer = req.headers.get("Authorization")?.replace(/^Bearer /, "");
	const payload: CliTokenPayload | null =
		bearer === SESSION
			? { sub: USER }
			: bearer === SERVICE
				? { sub: USER, service_token_org_id: ORG, service_token_id: TOKEN_ID }
				: bearer === NO_SUB
					? {}
					: null;
	if (payload) return { payload, error: null };
	const message = bearer === REVOKED ? "Unauthorized: Invalid or revoked service token" : "Unauthorized";
	return { payload: null, error: new Response(JSON.stringify({ error: message }), { status: 401 }) };
}

/** A CLI request to `path` carrying `bearer` (none when null) and an optional `X-Alethia-Org`. */
function cliRequest(path: string, bearer: string | null, org?: string, init: RequestInit = {}): Request {
	const headers = new Headers(init.headers);
	if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
	if (org) headers.set("X-Alethia-Org", org);
	return new Request(`https://console.local${path}`, { ...init, headers });
}

/** One CLI poll of the pending mint, exactly as `alethia` sends it. */
async function poll(bearer: string | null = SESSION, org?: string): Promise<Response> {
	return GET(cliRequest(`/api/cli/clusters/${CLUSTER}/kubeconfig/${MINT}`, bearer, org), {
		params: Promise.resolve({ id: CLUSTER, mintId: MINT }),
	});
}

/** The access_readonly activity rows written so far. */
function readonlyRows(): Record<string, unknown>[] {
	return activityRows.filter((r) => r.action === "access_readonly");
}

beforeEach(() => {
	vi.clearAllMocks();
	activityRows = [];
	grants = new Set([`${ORG}:access_readonly`]);
	isMember = true;
	resolverHonoursNamedOrg = true;
	mintReads = 0;
	const pdp = new PostgresRbacPDP();
	vi.spyOn(pdp, "can").mockImplementation(async (actor, action) =>
		grants.has(`${actor.orgId}:${action}`) ? { allowed: true } : { allowed: false, reason: "no_grant" },
	);
	vi.mocked(getPdp).mockReturnValue(pdp);
	vi.mocked(verifyCliToken).mockImplementation(async (req) => verdict(req));
	vi.mocked(getActiveScope).mockImplementation(async (userId, orgId) => ({
		userId,
		orgId: orgId && resolverHonoursNamedOrg ? orgId : ORG,
	}));
	vi.mocked(requestKubeconfigMint).mockImplementation(async (input) => ({
		ok: true,
		mint: {
			id: MINT,
			cluster_id: input.clusterId,
			job_id: JOB,
			tier: input.request.tier,
			shape: input.request.shape,
			ttl_seconds: input.request.ttl_seconds,
			status: "pending",
			expires_at: EXPIRES,
		},
	}));
});

describe("CLI kubeconfig mint poll — the entry gate records nothing per poll (#5670)", () => {
	it.each([
		["a session", SESSION],
		["a service token", SERVICE],
	])("N polls by %s write NO access_readonly row and emit no event", async (_who, bearer) => {
		const N = 5;
		for (let i = 0; i < N; i++) {
			const res = await poll(bearer);
			expect(res.status).toBe(200);
			expect((await res.json()).status).toBe("pending");
		}
		expect(mintReads).toBe(N);
		expect(readonlyRows()).toEqual([]);
		expect(emitActionEvent).not.toHaveBeenCalled();
	});

	it("the mint is on the record ONCE: the POST that starts it records one row, the polls after it none", async () => {
		const res = await POST(
			cliRequest(`/api/cli/clusters/${CLUSTER}/kubeconfig`, SESSION, undefined, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ shape: "exec", tier: "readonly", client_public_key: KEY }),
			}),
			{ params: Promise.resolve({ id: CLUSTER }) },
		);
		expect(res.status).toBe(202);
		for (let i = 0; i < 4; i++) expect((await poll()).status).toBe(200);
		expect(readonlyRows()).toEqual([
			expect.objectContaining({
				org_id: ORG,
				actor_id: USER,
				resource_type: "cluster",
				resource_id: CLUSTER,
				decision: true,
			}),
		]);
	});
});

describe("SECURITY: the quiet poll gate refuses exactly whom the recording gate refused (#5670)", () => {
	it("a caller WITHOUT access_readonly is refused on EVERY poll, and the mint is never read", async () => {
		grants = new Set();
		for (let i = 0; i < 3; i++) expect((await poll()).status).toBe(403);
		expect(mintReads).toBe(0);
	});

	it("access_readonly revoked between polls: the next poll is refused, decided afresh", async () => {
		expect((await poll()).status).toBe(200);
		grants = new Set();
		expect((await poll()).status).toBe(403);
		expect((await poll(SERVICE)).status).toBe(403);
		expect(mintReads).toBe(1);
	});

	it.each([
		["no bearer at all", null, undefined, 401],
		["a revoked service token", REVOKED, undefined, 401],
		["a token payload with no subject", NO_SUB, undefined, 400],
		["a service token with a CONFLICTING X-Alethia-Org", SERVICE, OTHER_ORG, 403],
		["a session naming an org it is not a member of", SESSION, OTHER_ORG, 403],
	])("%s is refused (%#)", async (_case, bearer, org, status) => {
		if (org === OTHER_ORG && bearer === SESSION) isMember = false;
		expect((await poll(bearer, org)).status).toBe(status);
		expect(mintReads).toBe(0);
	});

	it("a service token whose minter has LEFT the pinned org is refused (the offboarding re-check)", async () => {
		isMember = false;
		expect((await poll(SERVICE)).status).toBe(403);
		expect(mintReads).toBe(0);
	});

	it("a header naming an org the resolver does not land on is refused, never substituted", async () => {
		resolverHonoursNamedOrg = false;
		grants.add(`${OTHER_ORG}:access_readonly`);
		expect((await poll(SESSION, OTHER_ORG)).status).toBe(403);
		expect(mintReads).toBe(0);
	});

	it("the permission is asked in the HEADER's org, not the default one", async () => {
		// Holds access_readonly in ORG only; names OTHER_ORG, where it is a member without the grant.
		expect((await poll(SESSION, OTHER_ORG)).status).toBe(403);
		grants.add(`${OTHER_ORG}:access_readonly`);
		expect((await poll(SESSION, OTHER_ORG)).status).toBe(200);
	});
});

/** One parity case: how the request is made, and what the grants/membership look like. */
interface Case {
	name: string;
	bearer: string | null;
	org?: string;
	granted: boolean;
	member: boolean;
	honours: boolean;
}

const PARITY: ReadonlyArray<Case> = [
	{ name: "session, granted", bearer: SESSION, granted: true, member: true, honours: true },
	{ name: "session, not granted", bearer: SESSION, granted: false, member: true, honours: true },
	{ name: "service token, granted", bearer: SERVICE, granted: true, member: true, honours: true },
	{ name: "service token, not granted", bearer: SERVICE, granted: false, member: true, honours: true },
	{ name: "service token, minter left", bearer: SERVICE, granted: true, member: false, honours: true },
	{ name: "service token, conflicting header", bearer: SERVICE, org: OTHER_ORG, granted: true, member: true, honours: true },
	{ name: "session, header org not a member", bearer: SESSION, org: OTHER_ORG, granted: true, member: false, honours: true },
	{ name: "session, header org substituted", bearer: SESSION, org: OTHER_ORG, granted: true, member: true, honours: false },
	{ name: "no bearer", bearer: null, granted: true, member: true, honours: true },
	{ name: "revoked token", bearer: REVOKED, granted: true, member: true, honours: true },
	{ name: "no subject", bearer: NO_SUB, granted: true, member: true, honours: true },
];

/** The comparable part of a guard answer: the status, or the actor + credential + scope. */
async function shape(out: Awaited<ReturnType<typeof authorizeCli>>): Promise<unknown> {
	if ("error" in out) return { status: out.error.status, body: await out.error.text() };
	return out;
}

describe("authorizeCliQuiet makes authorizeCli's decision, and only authorizeCli records it", () => {
	it.each(PARITY)("$name: same answer from both; the recording one alone writes a row", async (c) => {
		const setUp = () => {
			grants = new Set(c.granted ? [`${ORG}:access_readonly`, `${OTHER_ORG}:access_readonly`] : []);
			isMember = c.member;
			resolverHonoursNamedOrg = c.honours;
		};
		const req = () => cliRequest("/api/cli/anything", c.bearer, c.org);
		const ref: { type: Resource; id?: string } = { type: "cluster", id: CLUSTER };

		setUp();
		const quiet = await shape(await authorizeCliQuiet(req(), "access_readonly", ref));
		expect(activityRows).toEqual([]);
		expect(emitActionEvent).not.toHaveBeenCalled();

		setUp();
		vi.mocked(getPdp).mockClear();
		const recorded = await shape(await authorizeCli(req(), "access_readonly", ref));
		expect(recorded).toEqual(quiet);
		// The recording guard writes a row exactly when the PDP was ASKED: an allow of this non-read
		// action, or a PDP denial. A refusal before the PDP (no token, the pin, membership) writes none.
		const askedPdp = vi.mocked(getPdp).mock.calls.length > 0;
		expect(activityRows).toHaveLength(askedPdp ? 1 : 0);
	});

	it("every OTHER caller keeps recording: authorizeCli on an action records the allow", async () => {
		grants.add(`${ORG}:manage_tokens`);
		const out = await authorizeCli(cliRequest("/api/cli/tokens", SESSION), "manage_tokens", { type: "org" });
		expect("error" in out).toBe(false);
		expect(activityRows).toEqual([
			expect.objectContaining({ action: "manage_tokens", actor_id: USER, org_id: ORG, decision: true }),
		]);
	});
});
