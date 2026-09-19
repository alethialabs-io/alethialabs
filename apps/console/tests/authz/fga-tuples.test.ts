// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	EMPTY_RESOURCE_ID,
	expandGrant,
	type GrantScope,
	grantScopeFromRow,
	hierarchyTuple,
	ORG_SCOPE_WITH_RESOURCE_ID,
	parseGrantResource,
	teamMemberTuple,
} from "@/lib/authz/fga-tuples";
import { resourceIdOf } from "@/lib/authz/grant-scope";
import { UNKNOWN_RESOURCE_TYPE } from "@/lib/validations/grants";
import { BUILT_IN_ROLES, PERMISSIONS } from "@/lib/authz/registry";

const ALL_KEYS: string[] = PERMISSIONS.map((p) => p.key);
const ownerKeys = ALL_KEYS; // owner = "*"
const viewer = BUILT_IN_ROLES.viewer;
const viewerKeys: string[] = viewer === "*" ? ALL_KEYS : viewer; // only :view keys

const base = { orgId: "O", principalType: "user" as const, principalId: "U" };

describe("expandGrant (role → permission tuples)", () => {
	it("org-wide allow writes one org capability per permission key", () => {
		const tuples = expandGrant(
			{ ...base, effect: "allow", resourceType: "org" },
			ownerKeys,
		);
		expect(tuples).toHaveLength(ownerKeys.length);
		for (const t of tuples) {
			expect(t.user).toBe("user:U");
			expect(t.object).toBe("org:O");
		}
		expect(tuples).toContainEqual({ user: "user:U", relation: "project_deploy", object: "org:O" });
		expect(tuples).toContainEqual({ user: "user:U", relation: "member_manage_members", object: "org:O" });
	});

	it("team principal uses the team#member userset", () => {
		const [t] = expandGrant(
			{ orgId: "O", principalType: "team", principalId: "T", effect: "allow", resourceType: "org" },
			["project:view"],
		);
		expect(t).toEqual({ user: "team:T#member", relation: "project_view", object: "org:O" });
	});

	it("project-scoped allow: project actions → perm_ on the project, no org-level, no create", () => {
		const tuples = expandGrant(
			{ ...base, effect: "allow", resourceType: "project", resourceId: "S" },
			ownerKeys,
		);
		expect(tuples).toContainEqual({ user: "user:U", relation: "perm_view", object: "project:S" });
		expect(tuples).toContainEqual({ user: "user:U", relation: "perm_deploy", object: "project:S" });
		// Projects are top-level (no descendants), so a scoped grant only writes perm_ on the project.
		expect(tuples.every((t) => t.object === "project:S")).toBe(true);
		expect(tuples.some((t) => t.relation === "member_manage_members")).toBe(false);
		// `create` is org-level and never conferred by a scoped grant.
		expect(tuples.some((t) => t.relation === "perm_create")).toBe(false);
	});

	it("leaf-scoped allow (runner) writes only perm_ on the runner", () => {
		const tuples = expandGrant(
			{ ...base, effect: "allow", resourceType: "runner", resourceId: "R" },
			ownerKeys,
		);
		expect(tuples.length).toBeGreaterThan(0);
		for (const t of tuples) {
			expect(t.object).toBe("runner:R");
			expect(t.relation.startsWith("perm_")).toBe(true);
		}
	});

	it("viewer role expands to view tuples plus own-support create/reply", () => {
		const tuples = expandGrant(
			{ ...base, effect: "allow", resourceType: "org" },
			viewerKeys,
		);
		expect(
			tuples.every(
				(t) =>
					t.relation.endsWith("_view") ||
					t.relation.endsWith("_view_activity") ||
					t.relation.endsWith("_view_alerts") ||
					// support is a right — viewers may open + reply to their own cases.
					t.relation === "support_case_create" ||
					t.relation === "support_case_reply",
			),
		).toBe(true);
	});

	it("a DENY grant writes deny_ relations (the exclusion)", () => {
		// deny a single permission on a specific project → perm_deny_ on that project
		const projectDeny = expandGrant(
			{ ...base, effect: "deny", resourceType: "project", resourceId: "S" },
			["project:view"],
		);
		expect(projectDeny).toContainEqual({ user: "user:U", relation: "perm_deny_view", object: "project:S" });

		// org-wide deny → the org deny capability
		const orgDeny = expandGrant(
			{ ...base, effect: "deny", resourceType: "org" },
			["project:view"],
		);
		expect(orgDeny).toContainEqual({ user: "user:U", relation: "project_deny_view", object: "org:O" });
	});
});

describe("hierarchy + team tuples", () => {
	it("hierarchyTuple makes the child point at its parent", () => {
		expect(hierarchyTuple({ childType: "project", childId: "S", parentType: "org", parentId: "O" })).toEqual({
			user: "org:O",
			relation: "parent",
			object: "project:S",
		});
	});
	it("teamMemberTuple links a user into a team", () => {
		expect(teamMemberTuple("T", "U")).toEqual({ user: "user:U", relation: "member", object: "team:T" });
	});
});

// ── #4582: the pair is not a value of the type ─────────────────────────────────────────────────
// These are COMPILE-TIME assertions. `tsc` over this file is what checks them: each
// `@ts-expect-error` fails the type-check if the line beneath it ever COMPILES — which is exactly
// what would happen if `GrantScope` went back to `resourceType: string; resourceId: string | null`.
// The runtime `expect`s only keep the values from being unused.
describe("GrantScope cannot hold the org kind with an id, or an unrecognised kind", () => {
	it("refuses them at compile time, fresh literal or not", () => {
		// @ts-expect-error — the org arm has no resourceId (typed `never`).
		const fresh: GrantScope = { ...base, effect: "allow", resourceType: "org", resourceId: "P" };

		// The case a plain `{ resourceType: "org" }` arm would have let through: a NON-fresh object
		// is checked structurally, and extra properties are allowed there. `resourceId?: never` is
		// what closes it.
		const widened = { ...base, effect: "allow" as const, resourceType: "org" as const, resourceId: "P" };
		// @ts-expect-error — the same pair, arriving as a variable rather than a literal.
		const nonFresh: GrantScope = widened;

		// @ts-expect-error — a scoped arm needs an id; null is not one.
		const nullId: GrantScope = { ...base, effect: "allow", resourceType: "project", resourceId: null };

		// @ts-expect-error — the kind is the closed PARENTS-derived union, not free text.
		const banana: GrantScope = { ...base, effect: "allow", resourceType: "banana", resourceId: "P" };

		// The controls: the two shapes a grant can mean DO compile.
		const org: GrantScope = { ...base, effect: "allow", resourceType: "org" };
		const connector: GrantScope = { ...base, effect: "allow", resourceType: "connector", resourceId: "C" };

		expect([fresh, nonFresh, nullId, banana, org, connector]).toHaveLength(6);
	});
});

// The write boundaries' refusal, now the only way a request's two strings become a `GrantResource`.
// Both directions are asserted: over-refusing here would break every legitimate grant, which is
// the failure a bad-pair-only test cannot see.
describe("parseGrantResource (the write boundaries' one parse)", () => {
	it("refuses the org kind carrying a resource id — the silent widening #4581 closed", () => {
		expect(parseGrantResource("org", "11111111-2222-3333-4444-555555555555")).toEqual({
			ok: false,
			error: ORG_SCOPE_WITH_RESOURCE_ID,
		});
		// An empty id under the org kind is still an id the request supplied.
		expect(parseGrantResource("org", "")).toEqual({ ok: false, error: ORG_SCOPE_WITH_RESOURCE_ID });
	});

	it("refuses an unrecognised kind, with an id AND without one (#4734)", () => {
		expect(parseGrantResource("projects", "P")).toEqual({ ok: false, error: UNKNOWN_RESOURCE_TYPE });
		// Without an id it would otherwise read as org-wide — the laundering the order prevents.
		expect(parseGrantResource("projects", null)).toEqual({ ok: false, error: UNKNOWN_RESOURCE_TYPE });
	});

	it("refuses an empty id on a scoped kind rather than storing it as ('org', '')", () => {
		expect(parseGrantResource("project", "")).toEqual({ ok: false, error: EMPTY_RESOURCE_ID });
	});

	it("parses a genuine org-wide grant — org kind, no id — to the org arm, with no resourceId", () => {
		const parsed = parseGrantResource("org", null);
		expect(parsed).toEqual({ ok: true, resource: { resourceType: "org" } });
		expect(parsed.ok && "resourceId" in parsed.resource).toBe(false);
	});

	it("parses a scopable kind with no id as org-wide, which is what both boundaries stored", () => {
		for (const kind of ["project", "runner", "cloud_identity", "connector"]) {
			expect(parseGrantResource(kind, null)).toEqual({ ok: true, resource: { resourceType: "org" } });
		}
	});

	it("parses every scopable kind carrying its own id — connector included (PARENTS, not GRANT_SCOPES)", () => {
		for (const kind of ["project", "runner", "cloud_identity", "connector"]) {
			const parsed = parseGrantResource(kind, "11111111-2222-3333-4444-555555555555");
			expect(parsed).toEqual({
				ok: true,
				resource: { resourceType: kind, resourceId: "11111111-2222-3333-4444-555555555555" },
			});
			// And it is stored with that id, not collapsed.
			expect(parsed.ok && resourceIdOf(parsed.resource)).toBe("11111111-2222-3333-4444-555555555555");
		}
	});
});

// A row already in the table cannot be refused, so it is narrowed — under the #4584 ruling, which
// `grantScopeFromRow` applies through `targetForEffect` rather than restating. Until #4584 the
// expander took the bad pair as ORGANIZATION-WIDE while the Postgres PDP read it as scoped to the
// id; the ruling is that it confers nothing on allow and excludes org-wide on deny.
describe("grantScopeFromRow (a stored row → the typed scope)", () => {
	const row = { ...base, effect: "allow" as const };
	const denyRow = { ...base, effect: "deny" as const };

	it("an ALLOW row of the bad pair is null — it confers nothing, neither org-wide nor scoped", () => {
		expect(grantScopeFromRow({ ...row, resourceType: "org", resourceId: "S" })).toBeNull();
	});

	it("an ALLOW row of an unrecognised kind is null — `resource_type` is free text in Postgres", () => {
		expect(grantScopeFromRow({ ...row, resourceType: "banana", resourceId: "S" })).toBeNull();
	});

	// RULED (#4584): a DENY row that scopes to nothing excludes ORG-WIDE. Asserted as a literal so
	// a reversal of `EMPTY_SCOPE_DENIES` cannot pass silently.
	it("a DENY row of either shape is the ORG arm — an ambiguous exclusion is not a licence", () => {
		for (const resourceType of ["org", "banana"]) {
			const scope = grantScopeFromRow({ ...denyRow, resourceType, resourceId: "S" });
			expect(scope).toEqual({ ...denyRow, resourceType: "org" });
			expect(scope === null ? [] : expandGrant(scope, ["project:view"])).toEqual([
				{ user: "user:U", relation: "project_deny_view", object: "org:O" },
			]);
		}
	});

	it("a null id is org-wide whatever the kind column says (the column's own contract)", () => {
		for (const resourceType of ["org", "project", "banana"]) {
			expect(grantScopeFromRow({ ...row, resourceType, resourceId: null })).toEqual({
				...row,
				resourceType: "org",
			});
		}
	});

	it("a scoped row keeps its kind and id — connector included", () => {
		const scope = grantScopeFromRow({ ...row, resourceType: "connector", resourceId: "C" });
		expect(scope).toEqual({ ...row, resourceType: "connector", resourceId: "C" });
		const tuples = scope === null ? [] : expandGrant(scope, ALL_KEYS);
		expect(tuples.length).toBeGreaterThan(0);
		expect(tuples.every((t) => t.object === "connector:C")).toBe(true);
	});
});
