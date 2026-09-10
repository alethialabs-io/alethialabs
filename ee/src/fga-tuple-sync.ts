// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// The OpenFGA dual-write writer. Postgres is the source of truth; this mirrors grant
// / hierarchy / team changes into the FGA store, and backfill() reconciles the whole
// store from Postgres at boot. Uses ONLY core's pure helpers (core.fga.*) + core.db
// (raw SQL) — no core runtime import. Standup-verified (needs a running OpenFGA).

import { OpenFgaClient } from "@openfga/sdk";
import { sql } from "drizzle-orm";
import type { FgaTuple } from "@/lib/authz/fga-tuples";
import type { HierarchyEdge, ScopedGrant, TupleSync } from "@/lib/authz/tuple-sync";
import type { CoreContext } from "@/lib/enterprise";

/** OpenFGA write batches are bounded; chunk to stay under the limit. */
const BATCH = 80;

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/** The OpenFGA subject string for a grant principal. */
function grantSubject(g: { principalType: "user" | "team"; principalId: string }): string {
	return g.principalType === "team"
		? `team:${g.principalId}#member`
		: `user:${g.principalId}`;
}

/**
 * The OpenFGA object a grant's tuples LIVE on — or null when the grant expands to no tuples and
 * there is consequently nothing to read or delete.
 *
 * THE INVARIANT: this must name the object every tuple `expandGrant` produces for the same scope
 * AND EFFECT sits on. It is therefore derived from the very predicate the expander expands
 * through, taken as an argument rather than reached for, so the two cannot be given different
 * ones — and it takes the effect for the same reason the expander does: an allow row is asked
 * what it confers, a deny row what it excludes, and those come apart for a row that scopes to
 * nothing (`EMPTY_SCOPE_DENIES` in apps/console/lib/authz/grant-scope.ts).
 *
 * It used to be `resourceId ? \`${resourceType}:${resourceId}\` : \`org:${orgId}\`` — the two
 * columns read independently of the expander. For an `('org', <resource-uuid>)` row that produced
 * `org:<resource-uuid>`, an object type/id pair that does not exist, while `expandGrant` had
 * written the tuples on `org:<orgId>`. The pre-write delete and `removeScopedGrant` both looked
 * there and found nothing, so REVOKING SUCH A GRANT REMOVED THE ROW AND LEFT THE ACCESS —
 * unrevokable privilege through the supported path, silent, with the UI showing the grant gone
 * (#4584). Two readers deciding separately where a grant's tuples are is the defect; one predicate
 * feeding both is the fix.
 *
 * Exported because that invariant is a PURE property and is unit-tested as one: for each scope
 * shape, expand the grant for real and assert every tuple's object equals what this returns (and
 * that an expansion of nothing returns null). Null is not an error — a row that confers nothing
 * wrote nothing.
 */
export function grantObject(
	targetForEffect: CoreContext["fga"]["targetForEffect"],
	g: {
		orgId: string;
		effect: "allow" | "deny";
		resourceType: string;
		resourceId: string | null;
	},
): string | null {
	const target = targetForEffect(g.effect, g.resourceType, g.resourceId);
	if (target.kind === "org") return `org:${g.orgId}`;
	if (target.kind === "resource") {
		return `${target.resourceType}:${target.resourceId}`;
	}
	return null;
}

export class FgaTupleSync implements TupleSync {
	constructor(
		private readonly core: CoreContext,
		private readonly client: OpenFgaClient,
	) {}

	/**
	 * The idempotent "replace this grant's tuples" delete: clear whatever the subject already has
	 * on the object this grant writes to. A no-op when the grant expands to nothing.
	 *
	 * ⚠ It does NOT clear tuples an already-existing bad-pair row wrote under the PRE-#4584
	 * reading. Those are on `org:<orgId>`, where they are indistinguishable from the tuples of a
	 * legitimate org-wide grant conferring the same permission on the same subject, so deleting
	 * them here would revoke real access. Whether any exist, and whether removing them takes
	 * access from anyone, is what the #4583 audit answers per row
	 * (docs/ops/grants-scope-contradictions.sql).
	 */
	private async clearGrantTuples(
		subject: string,
		grant: {
			orgId: string;
			effect: "allow" | "deny";
			resourceType: string;
			resourceId: string | null;
		},
	): Promise<void> {
		const object = grantObject(this.core.fga.targetForEffect, grant);
		if (object === null) return;
		await this.deleteTuples(await this.existingFor(subject, object));
	}

	private async writeTuples(tuples: FgaTuple[]): Promise<void> {
		for (const batch of chunk(tuples, BATCH)) {
			await this.client.write({ writes: batch }).catch(() => {
				// Tolerate already-exists on re-runs by retrying tuple-by-tuple.
				return Promise.allSettled(
					batch.map((t) => this.client.write({ writes: [t] })),
				).then(() => undefined);
			});
		}
	}

	private async deleteTuples(tuples: FgaTuple[]): Promise<void> {
		for (const batch of chunk(tuples, BATCH)) {
			await Promise.allSettled(
				batch.map((t) => this.client.write({ deletes: [t] })),
			);
		}
	}

	/** Current tuples for a subject on an object (to replace a grant idempotently). */
	private async existingFor(user: string, object: string): Promise<FgaTuple[]> {
		const res = await this.client.read({ user, object });
		return (res.tuples ?? [])
			.map((t) => t.key)
			.filter((k): k is FgaTuple => Boolean(k));
	}

	private async builtinRoleId(role: string): Promise<string | null> {
		const rows = await this.core.db.execute<{ id: string }>(
			sql`select id from role where name = ${role} and is_builtin = true limit 1`,
		);
		return rows[0]?.id ?? null;
	}

	async syncMemberGrant(orgId: string, userId: string, role: string): Promise<void> {
		const roleId = await this.builtinRoleId(role);
		if (!roleId) return;
		const keys = await this.core.fga.rolePermissionKeys(roleId);
		const tuples = this.core.fga.expandGrant(
			{
				orgId,
				principalType: "user",
				principalId: userId,
				effect: "allow",
				resourceType: "org",
				resourceId: null,
			},
			keys,
		);
		// Replace: drop the user's existing org-wide tuples, then write the new set.
		await this.deleteTuples(await this.existingFor(`user:${userId}`, `org:${orgId}`));
		await this.writeTuples(tuples);
	}

	async revokeMemberGrant(_orgId: string, userId: string): Promise<void> {
		// Remove every tuple where this user is the subject (org-wide + any scoped).
		const res = await this.client.read({ user: `user:${userId}` });
		const tuples = (res.tuples ?? [])
			.map((t) => t.key)
			.filter((k): k is FgaTuple => Boolean(k));
		await this.deleteTuples(tuples);
	}

	async syncScopedGrant(grant: ScopedGrant): Promise<void> {
		const keys = grant.permissionKey
			? [grant.permissionKey]
			: grant.roleId
				? await this.core.fga.rolePermissionKeys(grant.roleId)
				: [];
		const tuples = this.core.fga.expandGrant(
			{
				orgId: grant.orgId,
				principalType: grant.principalType,
				principalId: grant.principalId,
				effect: grant.effect,
				resourceType: grant.resourceType,
				resourceId: grant.resourceId,
			},
			keys,
		);
		await this.clearGrantTuples(grantSubject(grant), grant);
		await this.writeTuples(tuples);
	}

	async removeScopedGrant(grant: ScopedGrant): Promise<void> {
		await this.clearGrantTuples(grantSubject(grant), grant);
	}

	async syncHierarchyEdge(edge: HierarchyEdge): Promise<void> {
		await this.writeTuples([this.core.fga.hierarchyTuple(edge)]);
	}

	async removeHierarchyEdge(edge: HierarchyEdge): Promise<void> {
		await this.deleteTuples([this.core.fga.hierarchyTuple(edge)]);
	}

	async syncTeamMember(teamId: string, userId: string): Promise<void> {
		await this.writeTuples([this.core.fga.teamMemberTuple(teamId, userId)]);
	}

	async removeTeamMember(teamId: string, userId: string): Promise<void> {
		await this.deleteTuples([this.core.fga.teamMemberTuple(teamId, userId)]);
	}

	async resyncRole(roleId: string): Promise<void> {
		const keys = await this.core.fga.rolePermissionKeys(roleId);
		const grants = await this.core.db.execute<{
			org_id: string;
			principal_type: "user" | "team";
			principal_id: string;
			effect: "allow" | "deny";
			resource_type: string;
			resource_id: string | null;
		}>(sql`
			select org_id, principal_type, principal_id, effect, resource_type, resource_id
			from grants where role_id = ${roleId}
		`);
		for (const g of grants) {
			// The scope, EXACTLY as syncScopedGrant sees it. This loop used to inline its own
			// copy of the object expression and its own `g.resource_id ? g.resource_type : "org"`
			// normalisation — a structural duplicate that a fix to `grantObject` alone would have
			// left wrong, which is the shape where the second renderer never gets the fix.
			const scope = {
				orgId: g.org_id,
				principalType: g.principal_type,
				principalId: g.principal_id,
				effect: g.effect,
				resourceType: g.resource_type,
				resourceId: g.resource_id,
			};
			await this.clearGrantTuples(grantSubject(scope), scope);
			await this.writeTuples(this.core.fga.expandGrant(scope, keys));
		}
	}

	async backfill(): Promise<void> {
		// 1. Write (or refresh) the authorization model.
		await this.client.writeAuthorizationModel(this.core.fga.buildModel());

		// 2. Grants → permission tuples (expand each grant's role).
		const grants = await this.core.db.execute<{
			org_id: string;
			principal_type: "user" | "team";
			principal_id: string;
			effect: "allow" | "deny";
			role_id: string | null;
			permission_key: string | null;
			resource_type: string;
			resource_id: string | null;
		}>(sql`
			select org_id, principal_type, principal_id, effect, role_id, permission_key,
			       resource_type, resource_id
			from grants
		`);
		const tuples: FgaTuple[] = [];
		for (const g of grants) {
			const keys = g.permission_key
				? [g.permission_key]
				: g.role_id
					? await this.core.fga.rolePermissionKeys(g.role_id)
					: [];
			tuples.push(
				...this.core.fga.expandGrant(
					{
						orgId: g.org_id,
						principalType: g.principal_type,
						principalId: g.principal_id,
						effect: g.effect,
						resourceType: g.resource_type,
						resourceId: g.resource_id,
					},
					keys,
				),
			);
		}

		// 3. Hierarchy edges → parent tuples.
		const edges = await this.core.db.execute<{
			child_type: string;
			child_id: string;
			parent_type: string;
			parent_id: string;
		}>(sql`select child_type, child_id, parent_type, parent_id from resource_hierarchy`);
		for (const e of edges) {
			tuples.push(
				this.core.fga.hierarchyTuple({
					childType: e.child_type,
					childId: e.child_id,
					parentType: e.parent_type,
					parentId: e.parent_id,
				}),
			);
		}

		await this.writeTuples(tuples);
	}
}
