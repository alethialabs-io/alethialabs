// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import { enforceDecision } from "@/lib/authz/audit";
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
 * Community Policy Decision Point: scoped RBAC over plain Postgres. Resolves the
 * actor's grants (org + principal + permission), walks the Org→Zone→Spec hierarchy
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
	): Promise<{ resource_id: string | null; effect: string }[]> {
		return db.execute<{ resource_id: string | null; effect: string }>(sql`
			select g.resource_id, g.effect
			from grants g
			left join role_permission rp on rp.role_id = g.role_id
			where g.org_id = ${actor.orgId}
			  and g.principal_type = 'user'
			  and g.principal_id = ${actor.userId}
			  and (rp.permission_key = ${permKey} or g.permission_key = ${permKey})
		`);
	}

	/** Ids of `resourceType` that are descendants of (or equal to) the scoped ids. */
	private async descendantsOfType(
		db: Db,
		scoped: string[],
		resourceType: Resource,
	): Promise<string[]> {
		if (scoped.length === 0) return [];
		const rows = await db.execute<{ id: string }>(sql`
			with recursive descendants as (
				select child_id as id, child_type as type
				from resource_hierarchy where parent_id = any(${scoped}::uuid[])
				union
				select rh.child_id, rh.child_type
				from resource_hierarchy rh join descendants d on rh.parent_id = d.id
			)
			select distinct id from descendants where type = ${resourceType}
			union
			select id from (select unnest(${scoped}::uuid[]) as id) g
			where exists (
				select 1 from resource_hierarchy where child_id = g.id and child_type = ${resourceType}
			)
		`);
		return rows.map((r) => r.id);
	}

	/** Ancestor ids of a resource (Org→Zone→Spec, walked upward). */
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

		const allowIds = rows.filter((r) => r.effect === "allow").map((r) => r.resource_id);
		const denyIds = rows.filter((r) => r.effect === "deny").map((r) => r.resource_id);

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
		const allowIds = rows.filter((r) => r.effect === "allow").map((r) => r.resource_id);
		if (allowIds.length === 0) return [];
		const denyIds = rows.filter((r) => r.effect === "deny").map((r) => r.resource_id);
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
