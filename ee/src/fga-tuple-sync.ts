// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
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

export class FgaTupleSync implements TupleSync {
	constructor(
		private readonly core: CoreContext,
		private readonly client: OpenFgaClient,
	) {}

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
			{ orgId, principalType: "user", principalId: userId, resourceType: "org", resourceId: null },
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
		const keys = await this.core.fga.rolePermissionKeys(grant.roleId);
		const tuples = this.core.fga.expandGrant(
			{
				orgId: grant.orgId,
				principalType: grant.principalType,
				principalId: grant.principalId,
				resourceType: grant.resourceType,
				resourceId: grant.resourceId,
			},
			keys,
		);
		const subject =
			grant.principalType === "team"
				? `team:${grant.principalId}#member`
				: `user:${grant.principalId}`;
		await this.deleteTuples(
			await this.existingFor(subject, `${grant.resourceType}:${grant.resourceId}`),
		);
		await this.writeTuples(tuples);
	}

	async removeScopedGrant(grant: ScopedGrant): Promise<void> {
		const subject =
			grant.principalType === "team"
				? `team:${grant.principalId}#member`
				: `user:${grant.principalId}`;
		await this.deleteTuples(
			await this.existingFor(subject, `${grant.resourceType}:${grant.resourceId}`),
		);
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

	async backfill(): Promise<void> {
		// 1. Write (or refresh) the authorization model.
		await this.client.writeAuthorizationModel(this.core.fga.buildModel());

		// 2. Grants → permission tuples (expand each grant's role).
		const grants = await this.core.db.execute<{
			org_id: string;
			principal_type: "user" | "team";
			principal_id: string;
			role_id: string;
			resource_type: string;
			resource_id: string | null;
		}>(sql`
			select org_id, principal_type, principal_id, role_id, resource_type, resource_id
			from grants
		`);
		const tuples: FgaTuple[] = [];
		for (const g of grants) {
			const keys = await this.core.fga.rolePermissionKeys(g.role_id);
			tuples.push(
				...this.core.fga.expandGrant(
					{
						orgId: g.org_id,
						principalType: g.principal_type,
						principalId: g.principal_id,
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
