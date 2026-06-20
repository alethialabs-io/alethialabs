// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import { enforceDecision } from "@/lib/authz/audit";
import { listOrgResourceIds } from "@/lib/authz/resource-tables";
import { getServiceDb } from "@/lib/db";
import { coversResource, permissionKey } from "./evaluate";
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
	/** resource_ids of the actor's grants that already match org + principal + permission. */
	private async matchingGrantResourceIds(
		db: Db,
		actor: Actor,
		permKey: string,
	): Promise<(string | null)[]> {
		const rows = await db.execute<{ resource_id: string | null }>(sql`
			select g.resource_id
			from grants g
			join role_permission rp on rp.role_id = g.role_id
			where g.org_id = ${actor.orgId}
			  and g.principal_type = 'user'
			  and g.principal_id = ${actor.userId}
			  and rp.permission_key = ${permKey}
		`);
		return rows.map((r) => r.resource_id);
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
		const grantIds = await this.matchingGrantResourceIds(
			db,
			actor,
			permissionKey(resource.type, action),
		);
		if (grantIds.length === 0) return { allowed: false, reason: "no_grant" };

		// Org-wide grant short-circuits; otherwise compare against the ancestor chain.
		const orgWide = grantIds.some((id) => id === null);
		const ancestors =
			!orgWide && resource.id ? await this.ancestorIds(db, resource.id) : [];
		const allowed = coversResource(grantIds, resource.id, ancestors);
		return allowed ? { allowed: true } : { allowed: false, reason: "out_of_scope" };
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
		const grantIds = await this.matchingGrantResourceIds(
			db,
			actor,
			permissionKey(resourceType, action),
		);
		if (grantIds.length === 0) return [];

		// Org-wide grant ⇒ every resource of this type in the org.
		if (grantIds.some((id) => id === null)) {
			return listOrgResourceIds(resourceType, actor.orgId);
		}

		// Scoped grants ⇒ the granted resources of this type plus their descendants.
		const scoped = grantIds.filter((id): id is string => id !== null);
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
}
