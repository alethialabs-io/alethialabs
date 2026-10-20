// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE READ ROUTER'S TENANCY PROOF (#6113, ADR 0005 §10 Q4) — the body both edition files run.
//
// `rpc-tenancy.enterprise.test.ts` and `rpc-tenancy.community.test.ts` are two thin wrappers that
// pin `ALETHIA_EDITION` and install the three mocks below; everything they assert is HERE, so the
// two editions cannot drift apart. `vi.mock` has to live in the test file itself (it is hoisted per
// file), so the wrappers repeat three short mock factories — and `beforeAll` below checks that the
// wiring they installed is the wiring this body expects, so a wrapper that drifts goes red rather
// than proving something else.
//
// WHAT IS REAL. Postgres with RLS (the read runs as the app role), the PDP, `urlScopedOrgId`,
// `currentActor`, `getActiveScope`, the enterprise module (when the edition loads it), the oRPC
// client, handler and router. WHAT IS MOCKED, and only this:
//   · `next/headers` → `x-alethia-path` from `h.path`: the address the proxy publishes;
//   · `getOwnerScope` (the session lookup) → `{ userId: h.user, activeOrgId: h.sessionOrg }`: the
//     session is the INPUT under test, not the unit;
//   · `hasAcceptedCurrentDocuments` → true: the Terms gate has its own unit test (route.test.ts).
//
// WHAT IT PROVES, for EVERY procedure in `router` (enumerated from the router object — never a
// hand list), through BOTH entry points — the `/{org}/~/rpc` route handler, driven by a real
// `RPCLink` whose `fetch` is the handler, and the in-process server caller `serverOrpc()`:
//   1. ADDRESS BEATS SESSION. U (member of X and Y) with the session on X and the address on Y gets
//      exactly what U gets with the session on Y. In the enterprise edition that answer contains Y's
//      marker row and not X's.
//   2. A NON-MEMBER IS A 404. V (member of X only) addressing Y gets HTTP 404 from the handler and a
//      404 from the server caller — never Y's rows, and never X's.
//   3. WHAT IS AND IS NOT CLAIMED ABOUT THE SESSION. `getOwnerScope()` — the function that reads
//      `session.activeOrganizationId` (`readActiveOrgId`, `lib/auth/owner.ts`, NOT exported) — IS
//      called on these paths: `currentActor()` reads the whole owner scope before it asks the
//      address. So the session's org IS READ and then IGNORED wherever the address names an org
//      (`lib/authz/guard.ts`, `urlOrgId !== null` → `getActiveScope(userId, urlOrgId)`). That is
//      what invariant 1's equality measures; a stronger "never read" property does not hold and is
//      not asserted.
//
// ⚠ WHAT THE SERVER-CALLER HALF CAN AND CANNOT SEE. The route handler binds its resolved actor
// (`runWithActor`), so a reader's own `authorize()` reuses it. The server caller does NOT bind: it
// passes `context.actor`, and `jobs.page` — today's only procedure — never reads it; its reader
// calls `authorize()` → `currentActor()` and resolves the address again. So a server caller whose
// context came from the SESSION (`getActiveScope(userId, activeOrgId)`) still passes here while no
// procedure reads `context.actor`. Measured on #6113: that mutation alone stayed green; the same
// mutation with `jobs.page` binding `context.actor` turned four server-caller cases red (all three
// enterprise ones, and community's 404). The first procedure that consumes its context is covered
// the moment it enters FIXTURES.
//
// `serverOrpc()` IS CALLED AS SHIPPED. `react`'s `cache()` outside a server render is a pass-through
// (a fresh client per call), so no stand-in for `lib/rpc/server.ts` was needed.
//
// THE FIXTURE MAP IS THE EXTENSION POINT. A procedure in the router with no entry in `FIXTURES`
// fails the suite by name: lanes #6114–#6131 add procedures to the router, and each one must prove
// its tenancy here before it lands. An entry with no procedure behind it fails too.
//
// MARKER ROWS ARE AUTHORED BY W, NOT U. The `jobs` RLS policy has an owner arm (`user_id = owner`),
// so a row U authored would be visible on every one of U's pages and would mask the org arm this
// suite is about. W is a member of both orgs and never the caller.

import { randomUUID } from "node:crypto";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { ORPCError } from "@orpc/server";
import { eq, inArray } from "drizzle-orm";
import { headers } from "next/headers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET, POST } from "@/app/(private)/[org]/~/rpc/[[...rest]]/route";
import { getOwnerScope } from "@/lib/auth/owner";
import { ORG_PATH_HEADER } from "@/lib/authz/org-path";
import { ensureMemberGrant } from "@/lib/authz/grants";
import { seedAuthz } from "@/lib/authz/seed";
import { getServiceDb } from "@/lib/db";
import { authzActivityLog, grants, jobs, member, organization, user } from "@/lib/db/schema";
import { editionState } from "@/lib/enterprise";
import { errorDigest } from "@/lib/errors";
import { router } from "@/lib/rpc/router";
import { serverOrpc } from "@/lib/rpc/server";
import { describeIfDb, purgeAuthzActivityLog, seedJob } from "./db";

/** The request the mocks describe: the address, the signed-in user, and the session's org. */
export interface RpcTenancyRequest {
	path: string;
	user: string;
	sessionOrg: string | undefined;
}

/** The seeded world a fixture's markers are read against. */
export interface Seeded {
	jobX: string;
	jobY: string;
}

/** One procedure's tenancy fixture: an input it accepts, and how to find each org's marker in its output. */
export interface Fixture {
	input: unknown;
	markers(out: unknown, seeded: Seeded): { x: boolean; y: boolean };
}

/** Whether a page-shaped output (`{ rows: [{ id }] }`) carries a row with this id. */
function hasRow(out: unknown, id: string): boolean {
	if (typeof out !== "object" || out === null || !("rows" in out)) return false;
	const rows: unknown = out.rows;
	if (!Array.isArray(rows)) return false;
	return rows.some(
		(row: unknown) => typeof row === "object" && row !== null && "id" in row && row.id === id,
	);
}

/**
 * EVERY procedure in `router`, keyed by its dotted path. A new read procedure must add its entry
 * here — an input that reaches its reader, and a marker test that names X's and Y's seeded rows —
 * or this suite fails naming it.
 */
export const FIXTURES: Record<string, Fixture> = {
	"jobs.page": {
		input: { range: { preset: "12mo" } },
		markers: (out, s) => ({ x: hasRow(out, s.jobX), y: hasRow(out, s.jobY) }),
	},
};

/** Every procedure in a router, depth-first, as dotted paths (the shape `route.test.ts` walks). */
export function procedurePaths(node: object, path: string[] = []): string[] {
	const out: string[] = [];
	for (const [key, value] of Object.entries(node)) {
		if (value && typeof value === "object" && "~orpc" in value) out.push([...path, key].join("."));
		else if (value && typeof value === "object") out.push(...procedurePaths(value, [...path, key]));
	}
	return out;
}

/** Walks a proxy-shaped client (oRPC's) down a dotted path, without a cast. */
function walk(root: unknown, path: string): unknown {
	let node = root;
	for (const segment of path.split(".")) {
		if ((typeof node !== "object" && typeof node !== "function") || node === null) return undefined;
		node = Reflect.get(node, segment);
	}
	return node;
}

/** Calls a function reached by `walk`, failing loudly if the path did not lead to one. */
async function invoke(fn: unknown, input: unknown, label: string): Promise<unknown> {
	if (typeof fn !== "function") throw new Error(`${label} is not callable`);
	return fn(input);
}

/** The outcome of one call: what it returned, or what it threw, plus the HTTP status if it crossed one. */
type Outcome = { ok: true; value: unknown; status?: number } | { ok: false; error: unknown; status?: number };

/** Settles a call into an {@link Outcome}. */
async function settle(call: () => Promise<unknown>, status: () => number | undefined): Promise<Outcome> {
	try {
		const value = await call();
		return { ok: true, value, status: status() };
	} catch (error) {
		return { ok: false, error, status: status() };
	}
}

/** Whether a thrown value is the server caller's not-found: Next's 404 signal, or oRPC's NOT_FOUND. */
function isNotFound(error: unknown): boolean {
	if ((errorDigest(error) ?? "").startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) return true;
	return error instanceof ORPCError && error.code === "NOT_FOUND";
}

/**
 * Registers the tenancy suite for one edition. `h` is the hoisted request state the calling file's
 * mocks read; `edition` decides what U's answer for an address on Y must contain.
 */
export function runRpcTenancySuite(opts: {
	edition: "enterprise" | "community";
	h: RpcTenancyRequest;
}): void {
	const { edition, h } = opts;
	const ORG_X = randomUUID();
	const ORG_Y = randomUUID();
	const SLUG_X = `it-6113-${ORG_X.slice(0, 8)}`;
	const SLUG_Y = `it-6113-${ORG_Y.slice(0, 8)}`;
	const U = randomUUID(); // member of X and Y — the caller
	const V = randomUUID(); // member of X only — the non-member of Y
	const W = randomUUID(); // member of X and Y — authors the marker rows, never calls
	const USERS = [U, V, W];
	const seeded: Seeded = { jobX: "", jobY: "" };

	/** One call through the ROUTE HANDLER, as the browser makes it, under the given request. */
	async function viaRoute(path: string, req: RpcTenancyRequest): Promise<Outcome> {
		let status: number | undefined;
		const client = createORPCClient(
			new RPCLink({
				url: `http://console.test/${req.path.split("/")[1]}/~/rpc`,
				method: () => "GET",
				fetch: async (request) => {
					h.path = new URL(request.url).pathname;
					h.user = req.user;
					h.sessionOrg = req.sessionOrg;
					const res = request.method === "GET" ? await GET(request) : await POST(request);
					status = res.status;
					return res;
				},
			}),
		);
		return settle(() => invoke(walk(client, path), FIXTURES[path]?.input, `route client ${path}`), () => status);
	}

	/** One call through the IN-PROCESS SERVER CALLER (`serverOrpc()`), under the given request. */
	async function viaServer(path: string, req: RpcTenancyRequest): Promise<Outcome> {
		h.path = req.path;
		h.user = req.user;
		h.sessionOrg = req.sessionOrg;
		return settle(
			() => invoke(walk(serverOrpc(), `${path}.call`), FIXTURES[path]?.input, `serverOrpc() ${path}.call`),
			() => undefined,
		);
	}

	const ENTRY_POINTS = [
		["the route handler", viaRoute],
		["the server caller", viaServer],
	] as const;

	/** The address of procedure `path` under org `slug` (what a page under `/{slug}/~/jobs` publishes). */
	const rpcPath = (slug: string, path: string) => `/${slug}/~/rpc/${path.replaceAll(".", "/")}`;

	describeIfDb(`#6113 the read router's tenancy — ${edition} edition`, () => {
		beforeAll(async () => {
			// The edition is the premise of every assertion below. Enterprise REQUIRES ee/dist: a
			// module that failed to register must fail this suite, never skip it into community.
			const state = editionState();
			if (edition === "enterprise") {
				expect(
					state,
					"ee/dist/index.js must be built (`pnpm -F @alethia/ee build`) — the enterprise edition did not register",
				).toEqual({ kind: "enterprise" });
			} else {
				expect(state).toEqual({ kind: "community", reason: "configured" });
			}

			// The wrapper's mocks are the ones this body expects (see the header).
			h.path = "/probe/~/rpc";
			h.user = "probe-user";
			h.sessionOrg = "probe-org";
			expect((await headers()).get(ORG_PATH_HEADER)).toBe("/probe/~/rpc");
			expect(await getOwnerScope()).toEqual({ userId: "probe-user", sessionId: "s", activeOrgId: "probe-org" });

			const db = getServiceDb();
			await seedAuthz();
			await db.insert(user).values(USERS.map((id) => ({ id, email: `it-6113-${id}@example.test` })));
			await db.insert(organization).values([
				{ id: ORG_X, name: SLUG_X, slug: SLUG_X },
				{ id: ORG_Y, name: SLUG_Y, slug: SLUG_Y },
			]);
			await db.insert(member).values([
				{ organizationId: ORG_X, userId: U, role: "viewer" },
				{ organizationId: ORG_Y, userId: U, role: "viewer" },
				{ organizationId: ORG_X, userId: V, role: "viewer" },
				{ organizationId: ORG_X, userId: W, role: "admin" },
				{ organizationId: ORG_Y, userId: W, role: "admin" },
			]);
			// What signup writes for every user (`lib/auth/index.ts`): owner of their own personal scope.
			// Community serves every org address from that scope, so without it the PDP refuses there.
			for (const id of USERS) await ensureMemberGrant(id, id, "owner");
			await ensureMemberGrant(ORG_X, U, "viewer");
			await ensureMemberGrant(ORG_Y, U, "viewer");
			await ensureMemberGrant(ORG_X, V, "viewer");
			await ensureMemberGrant(ORG_X, W, "admin");
			await ensureMemberGrant(ORG_Y, W, "admin");

			seeded.jobX = await seedJob(W, ORG_X);
			seeded.jobY = await seedJob(W, ORG_Y);
			// The stamp is the premise of the markers; read it back rather than trust the insert.
			const stamped = await db
				.select({ id: jobs.id, org: jobs.org_id })
				.from(jobs)
				.where(inArray(jobs.id, [seeded.jobX, seeded.jobY]));
			expect(new Map(stamped.map((r) => [r.id, r.org]))).toEqual(
				new Map([
					[seeded.jobX, ORG_X],
					[seeded.jobY, ORG_Y],
				]),
			);
		});

		afterAll(async () => {
			const db = getServiceDb();
			await db.delete(jobs).where(inArray(jobs.org_id, [ORG_X, ORG_Y]));
			await purgeAuthzActivityLog(inArray(authzActivityLog.org_id, [ORG_X, ORG_Y, ...USERS]));
			await db.delete(grants).where(inArray(grants.org_id, [ORG_X, ORG_Y, ...USERS]));
			await db.delete(member).where(inArray(member.organizationId, [ORG_X, ORG_Y]));
			await db.delete(organization).where(inArray(organization.id, [ORG_X, ORG_Y]));
			await db.delete(user).where(inArray(user.id, USERS));
			await db.delete(jobs).where(eq(jobs.user_id, W));
		});

		describe("the fixture map covers the router exactly", () => {
			it("every procedure in the router has a tenancy fixture", () => {
				const missing = procedurePaths(router)
					.filter((path) => !(path in FIXTURES))
					.map((path) => `${path}: a new read procedure must prove its tenancy here (FIXTURES in rpc-tenancy.shared.ts)`);
				expect(missing).toEqual([]);
			});

			it("every fixture names a procedure that is in the router", () => {
				const paths = new Set(procedurePaths(router));
				expect(Object.keys(FIXTURES).filter((path) => !paths.has(path))).toEqual([]);
			});
		});

		const PATHS = procedurePaths(router);

		describe.each(ENTRY_POINTS)("through %s", (_label, call) => {
			it.each(PATHS)("%s — the address beats the session (session X, address Y ≡ session Y, address Y)", async (path) => {
				const mismatched = await call(path, { path: rpcPath(SLUG_Y, path), user: U, sessionOrg: ORG_X });
				const matched = await call(path, { path: rpcPath(SLUG_Y, path), user: U, sessionOrg: ORG_Y });
				expect(mismatched.ok, `session X / address Y failed: ${String(mismatched.ok ? "" : mismatched.error)}`).toBe(true);
				expect(matched.ok).toBe(true);
				if (!mismatched.ok || !matched.ok) return;
				if (mismatched.status !== undefined) expect(mismatched.status).toBe(200);
				expect(mismatched.value).toEqual(matched.value);

				const fixture = FIXTURES[path];
				if (!fixture) throw new Error(`${path} has no fixture`);
				const markers = fixture.markers(mismatched.value, seeded);
				if (edition === "enterprise") {
					// The multi-tenant answer: Y's rows, and nothing of X's.
					expect(markers).toEqual({ x: false, y: true });
				} else {
					// What COMMUNITY means: single-tenant. `currentActor()`'s arm 2 (lib/authz/guard.ts)
					// resolves every org address the caller is a member of to the PERSONAL scope, so U's
					// org-arm rows are U's own — and the markers, authored by W, are in neither.
					expect(markers).toEqual({ x: false, y: false });
				}
			});

			it.each(PATHS)("%s — the address beats the session the other way round (session Y, address X)", async (path) => {
				const mismatched = await call(path, { path: rpcPath(SLUG_X, path), user: U, sessionOrg: ORG_Y });
				const matched = await call(path, { path: rpcPath(SLUG_X, path), user: U, sessionOrg: ORG_X });
				expect(mismatched.ok && matched.ok).toBe(true);
				if (!mismatched.ok || !matched.ok) return;
				expect(mismatched.value).toEqual(matched.value);
				const fixture = FIXTURES[path];
				if (!fixture) throw new Error(`${path} has no fixture`);
				expect(fixture.markers(mismatched.value, seeded)).toEqual(
					edition === "enterprise" ? { x: true, y: false } : { x: false, y: false },
				);
			});

			it.each(PATHS)("%s — a non-member addressing Y gets a 404, never Y's rows nor X's", async (path) => {
				const outcome = await call(path, { path: rpcPath(SLUG_Y, path), user: V, sessionOrg: ORG_X });
				expect(outcome.ok, "a non-member was SERVED").toBe(false);
				if (outcome.ok) return;
				if (call === viaRoute) expect(outcome.status).toBe(404);
				else expect(isNotFound(outcome.error), `not a 404: ${String(outcome.error)}`).toBe(true);
			});
		});
	});
}
