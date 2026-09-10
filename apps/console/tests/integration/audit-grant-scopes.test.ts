// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the #4583 audit query (docs/ops/grants-scope-contradictions.sql), against real
// Postgres. This is the query whose EMPTY result is the gate on landing #4584 — so a wrong answer
// here does not produce a failing test, it produces a maintainer who believes a question has been
// answered. That makes it exactly the kind of read-only SQL that has to be executed rather than
// reviewed.
//
// Two things are asserted that nothing else can:
//
//  1. THE HAND-WRITTEN SCOPABLE LIST. The query must run in a bare psql session, so it spells out
//     `NOT IN ('project','runner','cloud_identity','connector')` rather than importing anything.
//     That literal is read back OUT of the file here and compared to `INSTANCE_TYPES`. A list
//     typed once and never checked is how a scopable kind silently becomes a finding — or, worse,
//     how a real contradiction stops being reported.
//
//  2. `also_org_wide` AND `verdict`. The verdict is the column that decides whether remediating a
//     row takes access away from a real person, and it is computed from a correlated subquery
//     with an effect match and a team-membership arm. None of that is visible by reading.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { INSTANCE_TYPES } from "@/lib/authz/fga-hierarchy";
import { seedAuthz } from "@/lib/authz/seed";
import { getServiceDb } from "@/lib/db";
import {
	grants,
	organization,
	projects,
	role,
	rolePermission,
	team,
	teamMember,
	user,
} from "@/lib/db/schema";
import { describeIfDb } from "./db";

const QUERY_FILE = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../docs/ops/grants-scope-contradictions.sql",
);
const QUERY = readFileSync(QUERY_FILE, "utf8");

const ORG = randomUUID();
const USER = randomUUID();
const TEAM = randomUUID();
const PROJECT = randomUUID();
const CONNECTOR = randomUUID(); // a scopable kind, id need not resolve — it is a CONTROL
const MISSING = randomUUID(); // names nothing in any table this query looks in
const ROLE = randomUUID(); // a custom role: exactly two permissions, so PARTIAL is 1 of 2

/** Stable ids so an assertion can name the row it is about. */
const ID = {
	redundant: randomUUID(),
	denyLive: randomUUID(),
	partial: randomUUID(),
	viaTeam: randomUUID(),
	noPermission: randomUUID(),
	unscopableLive: randomUUID(),
	unscopableRedundant: randomUUID(),
	unscopableDeny: randomUUID(),
	teamPrincipal: randomUUID(),
};

/** The audit's own output row. `execute` returns the columns the query SELECTs. */
type AuditRow = {
	id: string;
	pair_class: string;
	effect: string;
	resource_type: string;
	resource_kind: string;
	permissions: number;
	also_org_wide: number;
	also_allowed_anywhere: number;
	scope_today_pg: string;
	scope_today_fga: string;
	scope_after: string;
	deploy_change: string;
	verdict: string;
	subject: string | null;
	principal_type: string;
};

describeIfDb("the #4583 audit query (docs/ops/grants-scope-contradictions.sql)", () => {
	let rows: AuditRow[] = [];

	beforeAll(async () => {
		const db = getServiceDb();
		await seedAuthz(); // the permission catalog the FKs below need

		await db.insert(user).values({ id: USER, email: `it-audit-${USER}@example.test` });
		await db.insert(organization).values({ id: ORG, name: `audit-${ORG.slice(0, 8)}` });
		await db.insert(team).values({ id: TEAM, name: "platform", organizationId: ORG });
		await db.insert(teamMember).values({ teamId: TEAM, userId: USER });
		await db.insert(projects).values({
			id: PROJECT,
			user_id: ORG,
			org_id: ORG,
			project_name: `p-${PROJECT.slice(0, 6)}`,
			region: "eu-west-1",
			iac_version: "1.0.0",
		});
		// Two permissions, so a role-bearing row can be PARTIAL at exactly 1 of 2.
		await db.insert(role).values({
			id: ROLE,
			organization_id: ORG,
			name: `auditor-${ROLE.slice(0, 6)}`,
			is_builtin: false,
		});
		await db.insert(rolePermission).values([
			{ role_id: ROLE, permission_key: "project:view" },
			{ role_id: ROLE, permission_key: "runner:deploy" },
		]);

		await db.insert(grants).values([
			// ── CONTROLS. None of these may ever appear in the audit's output. ────────────────
			// Genuinely org-wide (resource_id NULL) — and what `also_org_wide` has to FIND.
			row({ effect: "allow", permission_key: "project:view", resource_type: "org", resource_id: null }),
			row({ effect: "allow", permission_key: "project:deploy", resource_type: "org", resource_id: null }),
			// Held by the TEAM the user belongs to — the membership arm of `also_org_wide`.
			row({ principal_type: "team", principal_id: TEAM, effect: "allow", permission_key: "project:edit", resource_type: "org", resource_id: null }),
			// A normal scoped grant.
			row({ effect: "allow", permission_key: "project:view", resource_type: "project", resource_id: PROJECT }),
			// A CONNECTOR-scoped grant. `connector` is in PARENTS and absent from GRANT_SCOPES,
			// and getting that wrong is exactly what #4582's text would have done — so a
			// connector grant appearing here would mean the audit had started reporting
			// working rows as contradictions.
			row({ effect: "allow", permission_key: "project:view", resource_type: "connector", resource_id: CONNECTOR }),

			// ── CLASS A: the 'org' kind carrying an id (legacy only since #4581). ─────────────
			// Already held org-wide by the same subject at the same effect.
			row({ id: ID.redundant, effect: "allow", permission_key: "project:view", resource_type: "org", resource_id: PROJECT }),
			// A DENY of the same key. The org-wide grant is an ALLOW, so it does NOT cover this:
			// effects must not cross, or the verdict answers a question nobody asked.
			row({ id: ID.denyLive, effect: "deny", permission_key: "project:view", resource_type: "org", resource_id: PROJECT }),
			// A role bundle: project:view is held org-wide, runner:deploy is not → 1 of 2.
			row({ id: ID.partial, effect: "allow", role_id: ROLE, resource_type: "org", resource_id: PROJECT }),
			// Covered ONLY through team membership, and the id names nothing findable.
			row({ id: ID.viaTeam, effect: "allow", permission_key: "project:edit", resource_type: "org", resource_id: MISSING }),
			// Neither a role nor a permission key.
			row({ id: ID.noPermission, effect: "allow", resource_type: "org", resource_id: PROJECT }),
			// A TEAM as the principal, covered by the team's own org-wide grant.
			row({ id: ID.teamPrincipal, principal_type: "team", principal_id: TEAM, effect: "allow", permission_key: "project:edit", resource_type: "org", resource_id: PROJECT }),

			// ── CLASS B: any other unscopable kind. STILL WRITEABLE today — the CLI route
			// validates resource_type as z.string().min(1). This class is why the audit was
			// widened: it is a real access removal on the community PDP, and the first version
			// of this query did not select it at all.
			row({ id: ID.unscopableLive, effect: "allow", permission_key: "runner:deploy", resource_type: "job", resource_id: PROJECT }),
			// A plain typo, conferring something the subject already holds org-wide.
			row({ id: ID.unscopableRedundant, effect: "allow", permission_key: "project:view", resource_type: "prject", resource_id: PROJECT }),
			// A class-B DENY. This is the row the deny ruling reaches WITHOUT having been decided
			// on it: today Postgres excludes only PROJECT and OpenFGA excludes nothing; after
			// #4584 both exclude the whole org. And the subject holds project:deploy org-wide
			// (the control above), so there IS something for the wider exclusion to bite.
			row({ id: ID.unscopableDeny, effect: "deny", permission_key: "project:deploy", resource_type: "job", resource_id: PROJECT }),
		]);

		rows = await db.execute<AuditRow>(sql.raw(QUERY));
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(grants).where(eq(grants.org_id, ORG));
		await db.delete(rolePermission).where(eq(rolePermission.role_id, ROLE));
		await db.delete(role).where(eq(role.id, ROLE));
		await db.delete(teamMember).where(eq(teamMember.teamId, TEAM));
		await db.delete(team).where(eq(team.id, TEAM));
		await db.delete(projects).where(eq(projects.org_id, ORG));
		await db.delete(organization).where(eq(organization.id, ORG));
		await db.delete(user).where(inArray(user.id, [USER]));
	});

	// ── 1. The hand-written list in the SQL is the hierarchy's, not a guess ──────────────────
	it("the scopable kinds excluded by the query ARE INSTANCE_TYPES", () => {
		const match = QUERY.match(/resource_type NOT IN \(([^)]*)\)/);
		if (!match) {
			throw new Error(
				"the audit query no longer has a `resource_type NOT IN (…)` clause — this test cannot pin what it does not find",
			);
		}
		const listed = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
		expect(new Set(listed)).toEqual(new Set(INSTANCE_TYPES));
		// Belt and braces on the direction that matters: `connector` is the one #4582's text
		// would have dropped, and dropping it here would report every connector-scoped grant
		// in the product as a contradiction.
		expect(listed).toContain("connector");
	});

	// ── 2. Only the contradictions, and both classes of them ────────────────────────────────
	it("returns exactly the contradictory rows — no org-wide, scoped or connector grant", () => {
		expect(new Set(rows.map((r) => r.id))).toEqual(new Set(Object.values(ID)));
	});

	it("selects the unscopable-kind class, which the first version of this query missed", () => {
		const classB = rows.filter((r) => r.pair_class === "unscopable-kind");
		expect(new Set(classB.map((r) => r.id))).toEqual(
			new Set([ID.unscopableLive, ID.unscopableRedundant, ID.unscopableDeny]),
		);
		expect(new Set(classB.map((r) => r.resource_type))).toEqual(new Set(["job", "prject"]));
		// And the two classes stay distinguishable, which is the whole point of reporting them
		// together rather than merging them.
		expect(rows.filter((r) => r.pair_class === "org-kind")).toHaveLength(6);
	});

	// ── 3. The verdict — the column a remediation decision is made from ─────────────────────
	const verdictOf = (list: AuditRow[], id: string): string => {
		const found = list.find((r) => r.id === id);
		if (!found) throw new Error(`the audit did not return the row ${id}`);
		return found.verdict;
	};

	it("REDUNDANT when an org-wide grant already confers it to the same subject", () => {
		expect(verdictOf(rows, ID.redundant)).toMatch(/^REDUNDANT/);
		expect(verdictOf(rows, ID.unscopableRedundant)).toMatch(/^REDUNDANT/);
	});

	it("REDUNDANT through TEAM MEMBERSHIP — access the user really has", () => {
		// The only thing conferring project:edit on this user org-wide is a grant to a team.
		// Without the membership arm this reads LIVE, and a maintainer is told that removing
		// the row changes access when it does not.
		expect(verdictOf(rows, ID.viaTeam)).toMatch(/^REDUNDANT/);
		// Same permission, but the principal IS the team.
		expect(verdictOf(rows, ID.teamPrincipal)).toMatch(/^REDUNDANT/);
	});

	it("LIVE for a DENY row whose only org-wide counterpart is an ALLOW", () => {
		// The effect match. Comparing across effects would call this REDUNDANT and invite a
		// maintainer to delete an exclusion that nothing else applies.
		expect(verdictOf(rows, ID.denyLive)).toMatch(/^LIVE/);
		expect(rows.find((r) => r.id === ID.denyLive)?.effect).toBe("deny");
	});

	it("LIVE for the unscopable-kind row nothing else covers", () => {
		expect(verdictOf(rows, ID.unscopableLive)).toMatch(/^LIVE/);
	});

	it("PARTIAL at 1 of 2 for a role bundle half-covered org-wide", () => {
		const partial = rows.find((r) => r.id === ID.partial);
		expect(partial?.permissions).toBe(2);
		expect(partial?.also_org_wide).toBe(1);
		expect(partial?.verdict).toMatch(/^PARTIAL/);
	});

	it("NO PERMISSION when the row references neither a role nor a permission key", () => {
		expect(verdictOf(rows, ID.noPermission)).toMatch(/^NO PERMISSION/);
		expect(rows.find((r) => r.id === ID.noPermission)?.permissions).toBe(0);
	});

	it("says LIVE about ORG-WIDE grants only, and the string says so", () => {
		// The query does not count a scoped grant that happens to cover the same resource, so
		// LIVE over-reports in the safe direction. The wording has to match what is measured.
		expect(verdictOf(rows, ID.denyLive)).toContain("ORG-WIDE");
		expect(verdictOf(rows, ID.denyLive)).not.toContain("nothing else confers");
	});

	// ── 3b. `deploy_change` — the OTHER question: what shipping #4584 does to this row ──────
	// `verdict` answers "if I remediate this, does someone lose access?". This answers "when this
	// DEPLOYS, does the row start meaning something wider or narrower?" — a different question,
	// and one a clean remediation verdict says nothing about. Nobody edits a row for it to
	// happen: `backfill` re-expands every raw grant on every boot.

	const rowFor = (id: string): AuditRow => {
		const found = rows.find((r) => r.id === id);
		if (!found) throw new Error(`the audit did not return the row ${id}`);
		return found;
	};

	it("an ALLOW row NARROWS — and the two classes narrow on different engines", () => {
		// org-kind: Postgres scoped it to the id, OpenFGA took it as org-wide. Both go to nothing.
		const a = rowFor(ID.redundant);
		expect(a.scope_today_pg).toBe("this-resource");
		expect(a.scope_today_fga).toBe("org-wide");
		expect(a.scope_after).toBe("nothing");
		expect(a.deploy_change).toMatch(/^NARROWS ON BOTH ENGINES/);

		// unscopable-kind: OpenFGA already conferred nothing, so only Postgres moves.
		const b = rowFor(ID.unscopableLive);
		expect(b.scope_today_fga).toBe("nothing");
		expect(b.deploy_change).toMatch(/^NARROWS ON POSTGRES/);
	});

	it("a DENY row WIDENS — and the org-kind one does not move OpenFGA", () => {
		// The row the ruling WAS decided on: OpenFGA already excluded the org, so it does not
		// move there — which is the argument the ruling was made on.
		const d = rowFor(ID.denyLive);
		expect(d.scope_today_pg).toBe("this-resource");
		expect(d.scope_today_fga).toBe("org-wide");
		expect(d.scope_after).toBe("org-wide");
		expect(d.deploy_change).toMatch(/^WIDENS ON POSTGRES/);
	});

	it("⚠ a class-B DENY widens on BOTH engines — the case the ruling was NOT decided on", () => {
		// This is the finding this arm exists for. `('job', <uuid>)` deny: Postgres excludes one
		// resource today, OpenFGA excludes NOTHING today, and after #4584 both exclude the whole
		// org. The ruling's own justification — "OpenFGA already does this" — is false here.
		const d = rowFor(ID.unscopableDeny);
		expect(d.pair_class).toBe("unscopable-kind");
		expect(d.effect).toBe("deny");
		expect(d.scope_today_pg).toBe("this-resource");
		expect(d.scope_today_fga).toBe("nothing");
		expect(d.scope_after).toBe("org-wide");
		expect(d.deploy_change).toMatch(/^WIDENS ON BOTH ENGINES/);
		expect(d.deploy_change).toContain("Removes access on first boot");
	});

	it("also_allowed_anywhere says whether a widened exclusion has anything to bite", () => {
		// The deny-side counterpart of `also_org_wide`. The subject holds project:deploy org-wide
		// (a control row), so widening this exclusion to the org REMOVES that access. A deny row
		// widening against a permission nobody holds would change nothing observable, and this is
		// the column that tells those two apart.
		const d = rowFor(ID.unscopableDeny);
		expect(d.permissions).toBe(1);
		expect(d.also_allowed_anywhere).toBe(1);
		// …and it is NOT the same number as also_org_wide, which asks the remediation question at
		// the SAME effect: there is no org-wide DENY of project:deploy for this subject.
		expect(d.also_org_wide).toBe(0);
	});

	// ── 4. `resource_kind` is a lookup in five tables, and says so when it misses ───────────
	it("resolves what the id names, and reports not-found rather than 'nothing'", () => {
		expect(rows.find((r) => r.id === ID.redundant)?.resource_kind).toBe("project");
		expect(rows.find((r) => r.id === ID.viaTeam)?.resource_kind).toBe("not-found");
	});
});

/** One `grants` row for this fixture. Defaults to USER in ORG; every field is overridable. */
function row(v: {
	id?: string;
	principal_type?: "user" | "team";
	principal_id?: string;
	effect: "allow" | "deny";
	role_id?: string;
	permission_key?: string;
	resource_type: string;
	resource_id: string | null;
}) {
	return {
		...(v.id === undefined ? {} : { id: v.id }),
		org_id: ORG,
		principal_type: v.principal_type ?? "user",
		principal_id: v.principal_id ?? USER,
		effect: v.effect,
		role_id: v.role_id ?? null,
		permission_key: v.permission_key ?? null,
		resource_type: v.resource_type,
		resource_id: v.resource_id,
	};
}
