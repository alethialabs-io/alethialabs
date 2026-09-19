// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import { enforceDecision } from "@/lib/authz/activity";
import { targetForEffect } from "@/lib/authz/grant-scope";
import { listOrgResourceIds } from "@/lib/authz/resource-tables";
import { getServiceDb } from "@/lib/db";
import { coversResource, decide, permissionKey } from "./evaluate";
import type { Action, Resource } from "./registry";
import type {
	Actor,
	BulkCheck,
	Decision,
	Pdp,
	ResourceRef,
} from "./types";

type Db = ReturnType<typeof getServiceDb>;

/**
 * A matched grant row, exactly as projected — the two scope columns and the effect.
 * A type alias, not an interface: `db.execute<T>` constrains T to `Record<string, unknown>`,
 * which an interface does not satisfy (no implicit index signature).
 */
type GrantRow = {
	resource_type: string;
	resource_id: string | null;
	effect: string;
};

/**
 * The rows of one effect, reduced to the ids they cover: `null` for an org-wide grant, the
 * resource id for a scoped one. This is the ONLY place this engine interprets a grant's scope,
 * and it does it through the same `targetForEffect` the OpenFGA expander uses.
 *
 * ⚠ THE EFFECT IS PASSED IN, AND IT IS NOT JUST A FILTER. An allow row is being asked what it
 * CONFERS; a deny row is being asked what it EXCLUDES. For a row whose scope resolves to nothing
 * those questions have opposite safe answers — conferring nothing is fail-closed, excluding
 * nothing is fail-OPEN — so `targetForEffect` routes them to different predicates rather than
 * letting one answer stand in for both. RULED (#4584): an uninterpretable scope confers nothing
 * and EXCLUDES THE WHOLE ORG. Two different values, both failing closed; see
 * `EMPTY_SCOPE_DENIES` in lib/authz/grant-scope.ts for the decision and the option it rejected.
 *
 * ⚠ THIS ENGINE IS WHERE THE RULING CHANGES LIVE ACCESS. It never projected `resource_type`, so
 * EVERY row with a non-null `resource_id` was scoped to that id here regardless of kind — which
 * means an allow row NARROWS to nothing and a deny row WIDENS to the whole org, on both classes,
 * with nobody editing anything. `backfill` re-expands raw rows on every boot, so the deploy is
 * what changes what they mean. Measured before deploy per row by `deploy_change` in
 * docs/ops/grants-scope-contradictions.sql; see `denyTarget` for which class widens on which
 * engine and why the ruling is uniform anyway.
 *
 * Before #4584 this engine did not project `resource_type` at all, so an `('org', <uuid>)` row
 * read as a scoped grant on that uuid while the OpenFGA engine read the same row as
 * organization-wide — one row, two opposite answers, decided by which engine an installation
 * happens to run.
 */
function coveredIds(rows: GrantRow[], effect: "allow" | "deny"): (string | null)[] {
	const ids: (string | null)[] = [];
	for (const row of rows) {
		if (row.effect !== effect) continue;
		const target = targetForEffect(effect, row.resource_type, row.resource_id);
		if (target.kind === "org") ids.push(null);
		else if (target.kind === "resource") ids.push(target.resourceId);
	}
	return ids;
}

/**
 * Community Policy Decision Point: scoped RBAC over plain Postgres. Resolves the
 * actor's grants (org + principal + permission), walks the Org→Project hierarchy
 * for scoped grants, and decides via the pure `coversResource`. Default-deny. The
 * enterprise tier swaps an OpenFgaPdp behind getPdp() with no call-site changes.
 */
export class PostgresRbacPDP implements Pdp {
	/**
	 * The actor's grants for a permission, with effect — matched either through a
	 * role (role_permission) OR a direct single-permission grant (g.permission_key).
	 */
	private async matchingGrants(
		db: Db,
		actor: Actor,
		permKey: string,
	): Promise<GrantRow[]> {
		// The actor's own grants PLUS grants to any team they belong to.
		//
		// `resource_type` is projected because a grant's scope is not readable from
		// `resource_id` alone: `coveredIds` needs both columns to reach the same verdict the
		// OpenFGA expander reaches. Both callers (`can`, `listAccessible`) consume the result
		// identically, through that one helper.
		return db.execute<GrantRow>(sql`
			select g.resource_type, g.resource_id, g.effect
			from grants g
			left join role_permission rp on rp.role_id = g.role_id
			where g.org_id = ${actor.orgId}
			  and (rp.permission_key = ${permKey} or g.permission_key = ${permKey})
			  and (
			    (g.principal_type = 'user' and g.principal_id = ${actor.userId})
			    or (g.principal_type = 'team' and g.principal_id in (
			      select team_id from team_member where user_id = ${actor.userId}
			    ))
			  )
		`);
	}

	/** Ids of `resourceType` that are descendants of (or equal to) the scoped ids. */
	private async descendantsOfType(
		db: Db,
		scoped: string[],
		resourceType: Resource,
	): Promise<string[]> {
		if (scoped.length === 0) return [];
		// drizzle's `sql` tag spreads a JS array into comma-separated scalar params, so
		// `${scoped}::uuid[]` casts a single scalar → Postgres 22P02. Build a real
		// `array[$1,$2,…]::uuid[]` literal instead so the uuid[] binds correctly.
		const ids = sql`array[${sql.join(
			scoped.map((s) => sql`${s}`),
			sql`, `,
		)}]::uuid[]`;
		const rows = await db.execute<{ id: string }>(sql`
			with recursive descendants as (
				select child_id as id, child_type as type
				from resource_hierarchy where parent_id = any(${ids})
				union
				select rh.child_id, rh.child_type
				from resource_hierarchy rh join descendants d on rh.parent_id = d.id
			)
			select distinct id from descendants where type = ${resourceType}
			union
			select id from (select unnest(${ids}) as id) g
			where exists (
				select 1 from resource_hierarchy where child_id = g.id and child_type = ${resourceType}
			)
		`);
		return rows.map((r) => r.id);
	}

	/** Ancestor ids of a resource (Org→Project, walked upward). */
	private async ancestorIds(db: Db, resourceId: string): Promise<string[]> {
		const rows = await db.execute<{ id: string }>(sql`
			with recursive anc as (
				select parent_id as id from resource_hierarchy where child_id = ${resourceId}
				union
				select rh.parent_id from resource_hierarchy rh join anc on rh.child_id = anc.id
			)
			select id from anc
		`);
		return rows.map((r) => r.id);
	}

	async can(
		actor: Actor,
		action: Action,
		resource: ResourceRef,
	): Promise<Decision> {
		const db = getServiceDb();
		const rows = await this.matchingGrants(
			db,
			actor,
			permissionKey(resource.type, action),
		);
		if (rows.length === 0) return { allowed: false, reason: "no_grant" };

		const allowIds = coveredIds(rows, "allow");
		const denyIds = coveredIds(rows, "deny");

		// Ancestors only matter when a scoped grant (allow or deny) is in play.
		const scoped =
			allowIds.some((id) => id !== null) || denyIds.some((id) => id !== null);
		const ancestors =
			scoped && resource.id ? await this.ancestorIds(db, resource.id) : [];

		if (decide(allowIds, denyIds, resource.id, ancestors)) return { allowed: true };
		const denied = coversResource(denyIds, resource.id, ancestors);
		return {
			allowed: false,
			reason: denied ? "explicit_deny" : allowIds.length ? "out_of_scope" : "no_grant",
		};
	}

	async enforce(
		actor: Actor,
		action: Action,
		resource: ResourceRef,
	): Promise<void> {
		const decision = await this.can(actor, action, resource);
		enforceDecision(actor, action, resource, decision);
	}

	async bulkCheck(actor: Actor, checks: BulkCheck[]): Promise<Decision[]> {
		return Promise.all(checks.map((c) => this.can(actor, c.action, c.resource)));
	}

	async listAccessible(
		actor: Actor,
		action: Action,
		resourceType: Resource,
	): Promise<string[]> {
		const db = getServiceDb();
		const rows = await this.matchingGrants(
			db,
			actor,
			permissionKey(resourceType, action),
		);
		const allowIds = coveredIds(rows, "allow");
		if (allowIds.length === 0) return [];
		const denyIds = coveredIds(rows, "deny");
		// An org-wide deny on this permission removes everything.
		if (denyIds.some((id) => id === null)) return [];

		// Candidate allowed ids: org-wide ⇒ all of the type; scoped ⇒ granted + descendants.
		const candidates = allowIds.some((id) => id === null)
			? await listOrgResourceIds(resourceType, actor.orgId)
			: await this.descendantsOfType(
					db,
					allowIds.filter((id): id is string => id !== null),
					resourceType,
				);

		// Subtract explicitly-denied ids (the deny target + its descendants of this type).
		const denyScoped = denyIds.filter((id): id is string => id !== null);
		if (denyScoped.length === 0) return candidates;
		const denied = new Set(
			await this.descendantsOfType(db, denyScoped, resourceType),
		);
		return candidates.filter((id) => !denied.has(id));
	}
}
