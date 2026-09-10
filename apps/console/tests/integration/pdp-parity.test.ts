// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: PDP ENGINE PARITY. Alethia ships two swappable Policy Decision Points behind
// the same `Pdp` seam — the community `PostgresRbacPDP` (scoped RBAC over Postgres grants) and
// the enterprise OpenFGA-backed engine. `getPdp()` swaps one for the other with no call-site
// change, so the two MUST return the same allow/deny on the same authorization question — a
// divergence would mean upgrading (or downgrading) a tenant silently changes who can do what,
// a real access-control hole.
//
// This drives BOTH real engines against ONE fixture (no mocks): the same grants are resolved by
// the real `PostgresRbacPDP` (SQL against Postgres) AND expanded — via the SAME production
// `expandGrant`/`hierarchyTuple` helpers the OpenFGA dual-write uses — into a REAL OpenFGA store
// that performs the ReBAC graph evaluation. The OpenFGA decision uses the production `checksFor`
// mapping + the store's `/check`, i.e. the exact `OpenFgaPdp.can` path. For every case in the
// matrix — INCLUDING cross-tenant reads — we assert the two engines AGREE, and that cross-tenant
// access is DENIED by both. See docs/compliance/security-e2e-matrix.md (CC6.1).

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { afterAll, beforeAll, expect, it } from "vitest";
import { checksFor, denyChecksFor } from "@/lib/authz/fga-mapping";
import { buildAuthorizationModel } from "@/lib/authz/fga-model";
import { expandGrant, hierarchyTuple, teamMemberTuple, type FgaTuple } from "@/lib/authz/fga-tuples";
import { EMPTY_SCOPE_DENIES } from "@/lib/authz/grant-scope";
import { PostgresRbacPDP } from "@/lib/authz/postgres-rbac-pdp";
import type { Action, Resource } from "@/lib/authz/registry";
import { listOrgResourceIds } from "@/lib/authz/resource-tables";
import { seedAuthz } from "@/lib/authz/seed";
import type { Actor } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import {
	grants,
	organization,
	projects,
	resourceHierarchy,
	team,
	teamMember,
	user,
} from "@/lib/db/schema";
import { DB_UP } from "./db";
import { describe } from "vitest";

// The host-reachable OpenFGA base URL (the .env value points at the docker-internal host).
const FGA_URL = process.env.OPENFGA_TEST_API_URL ?? "http://localhost:8082";

/** Probe OpenFGA once; the suite SKIPS (stays green) when it isn't reachable. */
async function fgaUp(): Promise<boolean> {
	try {
		const res = await fetch(`${FGA_URL}/healthz`, {
			signal: AbortSignal.timeout(2000),
		});
		return res.ok;
	} catch {
		return false;
	}
}
const FGA_UP = DB_UP ? await fgaUp() : false;

// A SILENT skip would let a green run hide that PDP↔PDP parity never ran (the community↔enterprise
// authz agreement, SOC2 CC6.1). Make the OpenFGA-absent skip LOUD, and let CI make it a HARD FAILURE
// via ALETHIA_PDP_PARITY_REQUIRE=1 (mirrors the sandbox canaries' assert-not-skip) once the CI
// integration lane provisions an OpenFGA service.
if (DB_UP && !FGA_UP) {
	const msg = `[pdp-parity] OpenFGA unreachable at ${FGA_URL} — the community↔enterprise PDP parity suite is SKIPPING. Start OpenFGA (pnpm dev:up) to run it.`;
	if (process.env.ALETHIA_PDP_PARITY_REQUIRE === "1") {
		throw new Error(`${msg} (ALETHIA_PDP_PARITY_REQUIRE=1 → refusing to silently skip)`);
	}
	console.warn(msg);
}
const describeParity = DB_UP && FGA_UP ? describe : describe.skip;

// ── Minimal typed OpenFGA HTTP client (real server = real ReBAC evaluation) ──────────
const storeSchema = z.object({ id: z.string() });
const modelSchema = z.object({ authorization_model_id: z.string() });
const checkSchema = z.object({ allowed: z.boolean().optional() });
const listObjectsSchema = z.object({ objects: z.array(z.string()).optional() });

async function post(path: string, body: unknown): Promise<unknown> {
	const res = await fetch(`${FGA_URL}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new Error(`OpenFGA POST ${path} → ${res.status}: ${await res.text()}`);
	}
	return res.json();
}

async function createStore(name: string): Promise<string> {
	return storeSchema.parse(await post("/stores", { name })).id;
}
async function writeModel(storeId: string): Promise<string> {
	return modelSchema.parse(
		await post(`/stores/${storeId}/authorization-models`, buildAuthorizationModel()),
	).authorization_model_id;
}
async function writeTuples(storeId: string, tuples: FgaTuple[]): Promise<void> {
	if (tuples.length === 0) return;
	await post(`/stores/${storeId}/write`, { writes: { tuple_keys: tuples } });
}
async function fgaCheck(
	storeId: string,
	modelId: string,
	tuple: FgaTuple,
): Promise<boolean> {
	const body = checkSchema.parse(
		await post(`/stores/${storeId}/check`, {
			tuple_key: tuple,
			authorization_model_id: modelId,
		}),
	);
	return body.allowed === true;
}

// ── Fixture ids (unique per run) ─────────────────────────────────────────────────────
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const USER_A = randomUUID(); // actor, member of ORG_A
const PROJ_A1 = randomUUID(); // in ORG_A, USER_A has a scoped view grant on it
const PROJ_A2 = randomUUID(); // in ORG_A, no scoped grant (org-wide deploy reaches it)
const PROJ_A3 = randomUUID(); // in ORG_A, org-wide deploy ALLOW + a per-instance deploy DENY
const PROJ_B1 = randomUUID(); // in ORG_B — the cross-tenant target
const TEAM_A = randomUUID(); // in ORG_A, USER_A is a member — the team-principal path

const pg = new PostgresRbacPDP();
const actor: Actor = { userId: USER_A, orgId: ORG_A };

describeParity("PDP engine parity (PostgresRbacPDP vs OpenFGA)", () => {
	let storeId = "";
	let modelId = "";

	beforeAll(async () => {
		const db = getServiceDb();
		await seedAuthz(); // permission/role catalog (grants.permission_key FK)

		await db.insert(user).values({ id: USER_A, email: `it-parity-${USER_A}@example.test` });
		await db.insert(organization).values([
			{ id: ORG_A, name: `A-${ORG_A.slice(0, 8)}` },
			{ id: ORG_B, name: `B-${ORG_B.slice(0, 8)}` },
		]);
		await db.insert(team).values({ id: TEAM_A, name: "platform", organizationId: ORG_A });
		await db.insert(teamMember).values({ teamId: TEAM_A, userId: USER_A });
		await db.insert(projects).values([
			mkProject(PROJ_A1, ORG_A),
			mkProject(PROJ_A2, ORG_A),
			mkProject(PROJ_A3, ORG_A),
			mkProject(PROJ_B1, ORG_B),
		]);
		// Org→Project edges (Postgres hierarchy + the FGA `parent` tuples both need them so an
		// org-wide capability reaches a specific instance identically in both engines).
		const edges = [
			{ childType: "project", childId: PROJ_A1, parentType: "org", parentId: ORG_A },
			{ childType: "project", childId: PROJ_A2, parentType: "org", parentId: ORG_A },
			{ childType: "project", childId: PROJ_A3, parentType: "org", parentId: ORG_A },
			{ childType: "project", childId: PROJ_B1, parentType: "org", parentId: ORG_B },
		];
		await db.insert(resourceHierarchy).values(
			edges.map((e) => ({
				child_type: e.childType,
				child_id: e.childId,
				parent_type: e.parentType,
				parent_id: e.parentId,
			})),
		);

		// The grants, in Postgres — the community engine resolves straight from these rows.
		// Explicit-deny is tested BOTH on `view` (scoped allow + scoped deny, no org-wide) AND
		// on `deploy` in COMBINATION with an org-wide ALLOW of the SAME action (G4 + G5 on
		// PROJ_A3) — the deny-wins case that used to diverge: `checksFor` ORs the raw org-wide
		// capability, so the OpenFGA engine must ALSO evaluate `denyChecksFor` and veto on the
		// per-instance deny to match the Postgres deny-wins engine (see the matrix, now CLOSED).
		const grantRows = [
			// G1: scoped view allow on PROJ_A1.
			grantRow({ permission_key: "project:view", resource_id: PROJ_A1 }),
			// G2 + G3: scoped view allow AND deny on PROJ_A2 → explicit-deny-wins (no org-wide view).
			grantRow({ permission_key: "project:view", resource_id: PROJ_A2 }),
			grantRow({ permission_key: "project:view", resource_id: PROJ_A2, effect: "deny" }),
			// G4: org-wide deploy across ORG_A.
			grantRow({ permission_key: "project:deploy", resource_id: null }),
			// G5: per-instance deploy DENY on PROJ_A3 → org-wide ALLOW (G4) + instance DENY of the
			// SAME action ⇒ explicit-deny-wins. THE regression case both engines must now DENY.
			grantRow({ permission_key: "project:deploy", resource_id: PROJ_A3, effect: "deny" }),
			// G6: THE BAD PAIR (#4584) — the `org` kind carrying a project's id. It reads as a
			// scoped grant on PROJ_A1 and is not one. Until #4584 the Postgres engine took it as
			// exactly that (it never projected `resource_type`) while `expandGrant` took it as
			// ORGANIZATION-WIDE and dropped the id — one row, opposite answers, decided by which
			// engine an installation runs. It now confers NOTHING on both.
			grantRow({
				permission_key: "project:edit",
				resource_type: "org",
				resource_id: PROJ_A1,
			}),
			// G7: the same permission, granted PROPERLY, scoped to PROJ_A2. Non-vacuity for G6:
			// without it, "edit is denied everywhere" would also be the answer for a permission
			// nobody holds, and the G6 cases would pass while asserting nothing.
			grantRow({ permission_key: "project:edit", resource_id: PROJ_A2 }),
			// G8: a TEAM principal, scoped to PROJ_A1. USER_A is a member, so both engines must
			// reach it — Postgres through `team_member`, OpenFGA through the `team:T#member`
			// userset. Nothing else in this fixture is granted to a team, so `expandGrant`'s
			// team branch and the membership tuple were both unexercised here.
			grantRow({
				principal_type: "team",
				principal_id: TEAM_A,
				permission_key: "project:plan",
				resource_id: PROJ_A1,
			}),
			// G9 + G10: the DENY scaffolding for the open ruling (#4584). An org-wide destroy
			// ALLOW, minus a destroy DENY written with the contradictory pair. Whichever way
			// `EMPTY_SCOPE_DENIES` is ruled, the two engines must AGREE — that assertion holds
			// under both, and only the `want` value below moves.
			grantRow({ permission_key: "project:destroy", resource_id: null }),
			grantRow({
				permission_key: "project:destroy",
				resource_type: "org",
				resource_id: PROJ_A3,
				effect: "deny",
			}),
		];
		await db.insert(grants).values(grantRows);

		// ── The OpenFGA half, DERIVED FROM THE ROWS POSTGRES NOW HOLDS ───────────────────────
		// This used to hand-write the `resourceType`/`resourceId` literals for each grant, which
		// is the SECOND reason this suite could not see #4584 and the more dangerous one: the FGA
		// side was fed whatever the test author typed, not what the database contained, so adding
		// a bad-pair row to the DB fixture alone would still have passed. Two fixtures that drift
		// silently is exactly the divergence this file exists to detect.
		//
		// So: read the grants back out and expand each one through the same production
		// `expandGrant` the ee/ dual-write calls. Nothing between the table and the store is
		// re-typed by hand.
		storeId = await createStore(`parity-${ORG_A.slice(0, 8)}`);
		modelId = await writeModel(storeId);
		const seeded = await db
			.select({
				org_id: grants.org_id,
				principal_type: grants.principal_type,
				principal_id: grants.principal_id,
				effect: grants.effect,
				permission_key: grants.permission_key,
				resource_type: grants.resource_type,
				resource_id: grants.resource_id,
			})
			.from(grants)
			.where(eq(grants.org_id, ORG_A));
		// Counted against the fixture itself, not against a number typed here — a hand-written
		// count decays the moment someone adds a case. A short read would write too few tuples
		// and make every OpenFGA answer a silent `false`, which agrees with a Postgres `false`
		// for all the wrong reasons; a `beforeAll` that throws says so loudly.
		if (seeded.length !== grantRows.length) {
			throw new Error(
				`fixture: inserted ${grantRows.length} grants for ORG_A but read back ${seeded.length} — the OpenFGA half is DERIVED from these rows, so it would be expanded from an incomplete fixture.`,
			);
		}
		const tuples: FgaTuple[] = [
			...seeded.flatMap((row) =>
				expandGrant(
					{
						orgId: row.org_id,
						principalType: principalTypeOf(row.principal_type),
						principalId: row.principal_id,
						effect: effectOf(row.effect),
						resourceType: row.resource_type,
						resourceId: row.resource_id,
					},
					permissionKeysOf(row.permission_key),
				),
			),
			...edges.map((e) => hierarchyTuple(e)),
			// Team membership is a fact about the org, not about a grant, so it is not something
			// `expandGrant` can derive from a `grants` row — the dual-write mirrors it separately
			// (`syncTeamMember`). Without it G8 reaches nobody and its cases would pass vacuously.
			teamMemberTuple(TEAM_A, USER_A),
		];
		await writeTuples(storeId, tuples);
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(grants).where(eq(grants.org_id, ORG_A));
		await db
			.delete(resourceHierarchy)
			.where(inArray(resourceHierarchy.parent_id, [ORG_A, ORG_B]));
		await db.delete(projects).where(inArray(projects.org_id, [ORG_A, ORG_B]));
		await db.delete(organization).where(inArray(organization.id, [ORG_A, ORG_B]));
		await db.delete(teamMember).where(eq(teamMember.teamId, TEAM_A));
		await db.delete(team).where(eq(team.id, TEAM_A));
		await db.delete(user).where(eq(user.id, USER_A));
		if (storeId) {
			await fetch(`${FGA_URL}/stores/${storeId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	/** The OpenFGA engine's decision, exactly as OpenFgaPdp.can computes it: SOME allow
	 * check passes AND NO deny check vetoes (explicit-deny-wins). */
	async function fgaAllowed(action: Action, resource: { type: Resource; id: string }): Promise<boolean> {
		const opts = { id: resource.id, orgId: actor.orgId };
		const runChecks = (checks: ReturnType<typeof checksFor>) =>
			Promise.all(
				checks.map((c) => fgaCheck(storeId, modelId, { user: `user:${USER_A}`, relation: c.relation, object: c.object })),
			);
		const [allowResults, denyResults] = await Promise.all([
			runChecks(checksFor(resource.type, action, opts)),
			runChecks(denyChecksFor(resource.type, action, opts)),
		]);
		if (denyResults.some((r) => r)) return false;
		return allowResults.some((r) => r);
	}

	/** The OpenFGA engine's `listAccessible`, mirroring `OpenFgaPdp.listAccessible` exactly
	 * (same reimplement-and-compare style as `fgaAllowed`). The ORG-WIDE path must be
	 * deny-aware: org-wide deny ⇒ [], else all org instances MINUS the per-instance denies
	 * (listObjects `deny_<action>`). The scoped path uses `can_<action>`, itself deny-aware. */
	async function fgaListAccessible(action: Action, resourceType: Resource): Promise<string[]> {
		const user = `user:${USER_A}`;
		const listObjects = async (relation: string): Promise<string[]> => {
			const raw = listObjectsSchema.parse(
				await post(`/stores/${storeId}/list-objects`, {
					user,
					relation,
					type: resourceType,
					authorization_model_id: modelId,
				}),
			);
			return (raw.objects ?? [])
				.map((o) => o.split(":")[1])
				.filter((id): id is string => Boolean(id));
		};
		const orgAllow = await fgaCheck(storeId, modelId, {
			user,
			relation: `${resourceType}_${action}`,
			object: `org:${actor.orgId}`,
		});
		if (orgAllow) {
			const orgDeny = await fgaCheck(storeId, modelId, {
				user,
				relation: `${resourceType}_deny_${action}`,
				object: `org:${actor.orgId}`,
			});
			if (orgDeny) return [];
			const [allIds, deniedIds] = await Promise.all([
				listOrgResourceIds(resourceType, actor.orgId),
				listObjects(`deny_${action}`),
			]);
			const denied = new Set(deniedIds);
			return allIds.filter((id) => !denied.has(id));
		}
		return listObjects(`can_${action}`);
	}

	const cases: { name: string; action: Action; id: string; want: boolean }[] = [
		{ name: "scoped view allow on PROJ_A1", action: "view", id: PROJ_A1, want: true },
		{ name: "view PROJ_A2 (explicit deny wins over scoped allow)", action: "view", id: PROJ_A2, want: false },
		{ name: "view PROJ_B1 (CROSS-TENANT, scoped grant does not reach)", action: "view", id: PROJ_B1, want: false },
		{ name: "org-wide deploy on PROJ_A1", action: "deploy", id: PROJ_A1, want: true },
		{ name: "org-wide deploy on PROJ_A2", action: "deploy", id: PROJ_A2, want: true },
		// The previously-avoided divergence: org-wide ALLOW + per-instance DENY of the SAME
		// action. Postgres denies (deny-wins); OpenFGA must now ALSO deny (denyChecksFor veto).
		{ name: "org-wide deploy ALLOW + per-instance DENY on PROJ_A3 (deny wins)", action: "deploy", id: PROJ_A3, want: false },

		// ── #4584: the bad pair (G6), read on three projects ─────────────────────────────────
		// G6 is `('org', PROJ_A1)` allow project:edit; G7 is a proper `('project', PROJ_A2)`
		// allow of the same permission. The third row is where the old divergence SHOWS: under
		// the pre-#4584 readings Postgres scoped G6 to PROJ_A1 (so `edit` on PROJ_A3 was false)
		// while OpenFGA took G6 as org-wide (so `edit` on PROJ_A3 was TRUE). That is the
		// `ENGINE DIVERGENCE` assertion firing, and it fires only because the OpenFGA half is
		// now derived from the row rather than composed from literals.
		{ name: "edit on PROJ_A1 — the bad pair names it and confers nothing", action: "edit", id: PROJ_A1, want: false },
		{ name: "edit on PROJ_A2 — the PROPERLY scoped grant does confer it (non-vacuity for the two false cases)", action: "edit", id: PROJ_A2, want: true },
		{ name: "edit on PROJ_A3 — the bad pair is NOT org-wide either", action: "edit", id: PROJ_A3, want: false },

		// A grant to a TEAM the actor belongs to. Postgres resolves it through `team_member`,
		// OpenFGA through the `team:T#member` userset — two entirely different mechanisms that
		// must agree, and neither was exercised by this fixture before.
		{ name: "plan on PROJ_A1 via a TEAM grant (member of TEAM_A)", action: "plan", id: PROJ_A1, want: true },
		{ name: "plan on PROJ_A2 — the team grant is scoped to A1", action: "plan", id: PROJ_A2, want: false },

		// ── #4584, the UNDECIDED deny direction ──────────────────────────────────────────────
		// Org-wide destroy ALLOW + a destroy DENY written with the contradictory pair on A3.
		// The parity assertion holds either way; `want` is read from the constant so the
		// maintainer's ruling is a one-line change here too. Under "nothing" the deny is
		// dropped and A3 keeps destroy (fail-OPEN); under "the_whole_org" the exclusion applies
		// to every project in the org.
		{ name: "destroy on PROJ_A3 — the bad-pair DENY, per EMPTY_SCOPE_DENIES", action: "destroy", id: PROJ_A3, want: EMPTY_SCOPE_DENIES !== "the_whole_org" },
		{ name: "destroy on PROJ_A1 — a project the bad-pair DENY does not name", action: "destroy", id: PROJ_A1, want: EMPTY_SCOPE_DENIES !== "the_whole_org" },
	];

	for (const c of cases) {
		it(`agrees: ${c.name}`, async () => {
			const pgDecision = await pg.can(actor, c.action, { type: "project", id: c.id });
			const fgaDecision = await fgaAllowed(c.action, { type: "project", id: c.id });

			// The load-bearing assertion: the two engines return the SAME allow/deny.
			expect(
				pgDecision.allowed,
				`ENGINE DIVERGENCE on ${c.name}: Postgres=${pgDecision.allowed} OpenFGA=${fgaDecision}`,
			).toBe(fgaDecision);
			// And the fixture's intended decision.
			expect(pgDecision.allowed).toBe(c.want);
		});
	}

	it("cross-tenant read is DENIED by BOTH engines", async () => {
		// USER_A (org A) asking to view PROJ_B1 (org B): the scoped grant does not reach it and
		// there is no org-wide view, so neither the RBAC decision nor the ReBAC store allows it.
		const pgDecision = await pg.can(actor, "view", { type: "project", id: PROJ_B1 });
		const fgaDecision = await fgaAllowed("view", { type: "project", id: PROJ_B1 });
		expect(pgDecision.allowed).toBe(false);
		expect(fgaDecision).toBe(false);
	});

	it("listAccessible agrees and never crosses the tenant boundary", async () => {
		// Community engine: the projects USER_A may VIEW (scoped grant → PROJ_A1 only).
		const pgIds = await pg.listAccessible(actor, "view", "project");

		// OpenFGA engine: listObjects for the same relation (no org-wide view grant → scoped path).
		const raw = listObjectsSchema.parse(
			await post(`/stores/${storeId}/list-objects`, {
				user: `user:${USER_A}`,
				relation: "can_view",
				type: "project",
				authorization_model_id: modelId,
			}),
		);
		const fgaIds = (raw.objects ?? []).map((o) => o.split(":")[1]);

		expect(new Set(pgIds)).toEqual(new Set([PROJ_A1]));
		expect(new Set(fgaIds)).toEqual(new Set(pgIds));
		// Neither engine may ever list a project the actor does not own (cross-tenant).
		expect(pgIds).not.toContain(PROJ_B1);
		expect(fgaIds).not.toContain(PROJ_B1);
	});

	it("listAccessible agrees on the ORG-WIDE path (deny is subtracted, not ignored)", async () => {
		// `deploy` is org-wide across ORG_A (G4) WITH a per-instance deploy DENY on PROJ_A3 (G5)
		// — the org-wide analogue of the `can()` deny-wins case. The OpenFGA org-wide branch used
		// to return EVERY org instance with no deny subtraction (`listOrgResourceIds` verbatim),
		// so it silently INCLUDED PROJ_A3 while Postgres excluded it: "act on the whole org except
		// this one project" over-permitted on the enterprise tier. Both engines must now exclude it.
		const pgIds = await pg.listAccessible(actor, "deploy", "project");
		const fgaIds = await fgaListAccessible("deploy", "project");

		// Postgres: all ORG_A projects (A1, A2 org-wide) MINUS the per-instance-denied A3.
		expect(new Set(pgIds)).toEqual(new Set([PROJ_A1, PROJ_A2]));
		expect(pgIds).not.toContain(PROJ_A3);
		// The load-bearing assertion: the OpenFGA engine AGREES — deny is subtracted here too.
		expect(new Set(fgaIds)).toEqual(new Set(pgIds));
		expect(fgaIds).not.toContain(PROJ_A3);
		// And never leaks a cross-tenant project.
		expect(fgaIds).not.toContain(PROJ_B1);
	});

	it("listAccessible agrees on the bad pair: it widens NEITHER engine's list", async () => {
		// `edit` is held by exactly one grant that confers anything — G7, scoped to PROJ_A2.
		// G6, the `('org', PROJ_A1)` row, must not add PROJ_A1 (the id it names) and must not
		// turn this into the org-wide branch. Before #4584 the OpenFGA engine took precisely
		// that org-wide branch here and returned every project in ORG_A minus the denies, while
		// Postgres returned [A1, A2] — the listing form of the same divergence.
		const pgIds = await pg.listAccessible(actor, "edit", "project");
		const fgaIds = await fgaListAccessible("edit", "project");

		expect(new Set(pgIds)).toEqual(new Set([PROJ_A2]));
		expect(new Set(fgaIds)).toEqual(new Set(pgIds));
		expect(fgaIds).not.toContain(PROJ_A1);
		expect(fgaIds).not.toContain(PROJ_A3);
		expect(fgaIds).not.toContain(PROJ_B1);
	});
});

/** A projects row for the fixture (minimal required columns). */
function mkProject(id: string, orgId: string) {
	return {
		id,
		user_id: orgId,
		org_id: orgId,
		project_name: `p-${id.slice(0, 6)}`,
		region: "eu-west-1",
		iac_version: "1.0.0",
	};
}

/**
 * A grant row for USER_A in ORG_A.
 *
 * `resource_type` is a PARAMETER, not a constant. It used to be hardcoded to `"project"`, which
 * is why this suite could not see #4584 at all: the row shape at the centre of that divergence —
 * an `'org'` kind carrying a resource id — was unconstructible from the fixture.
 */
function grantRow(v: {
	permission_key: string;
	resource_id: string | null;
	effect?: "allow" | "deny";
	resource_type?: string;
	principal_type?: "user" | "team";
	principal_id?: string;
}) {
	return {
		org_id: ORG_A,
		principal_type: v.principal_type ?? ("user" as const),
		principal_id: v.principal_id ?? USER_A,
		effect: v.effect ?? ("allow" as const),
		permission_key: v.permission_key,
		resource_type: v.resource_type ?? "project",
		resource_id: v.resource_id,
	};
}

// ── Narrowing the rows read back from Postgres ───────────────────────────────────────────────
// `grants.principal_type`, `.effect` and `.permission_key` are `text`/nullable in the schema, and
// `GrantScope` wants unions. These narrow rather than cast (CLAUDE.md §6), and they THROW on
// anything unexpected: every row came from this file's own fixture, so an unexpected value means
// the fixture is broken and the run must say so — not quietly expand a grant it misread.

/** The principal kind, narrowed. */
function principalTypeOf(value: string): "user" | "team" {
	if (value === "user" || value === "team") return value;
	throw new Error(`fixture: unexpected grants.principal_type ${JSON.stringify(value)}`);
}

/** The effect, narrowed. */
function effectOf(value: string): "allow" | "deny" {
	if (value === "allow" || value === "deny") return value;
	throw new Error(`fixture: unexpected grants.effect ${JSON.stringify(value)}`);
}

/** The permission keys a fixture row confers. Every row here is a direct single-permission grant. */
function permissionKeysOf(value: string | null): string[] {
	if (value === null) {
		throw new Error("fixture: a grant row with no permission_key (roles are not used here)");
	}
	return [value];
}
