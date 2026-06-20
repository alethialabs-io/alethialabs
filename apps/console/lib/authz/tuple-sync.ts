// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The dual-write seam: Postgres stays the source of truth; every grant/edge/team
// mutation also mirrors to OpenFGA tuples. Core default is a no-op (community runs
// PostgresRbacPDP, no OpenFGA); the ee/ FgaTupleSync writes to the FGA store. Callers
// (grants.ts, the hierarchy-edge inserts, team hooks, instrumentation) go through
// getTupleSync() and never import ee/. Writes are best-effort/fire-and-forget at the
// call sites — Postgres is authoritative, and backfill() reconciles any drift.

import { getEnterprise } from "@/lib/enterprise";

export interface HierarchyEdge {
	childType: string;
	childId: string;
	parentType: string;
	parentId: string;
}

export interface ScopedGrant {
	orgId: string;
	principalType: "user" | "team";
	principalId: string;
	effect: "allow" | "deny";
	resourceType: string;
	resourceId: string;
	/** A role bundle XOR a single permission key. */
	roleId: string | null;
	permissionKey: string | null;
}

export interface TupleSync {
	/** Set a member's org-wide capabilities to `role`'s permissions (replace prior). */
	syncMemberGrant(orgId: string, userId: string, role: string): Promise<void>;
	/** Remove all of a member's tuples in the org. */
	revokeMemberGrant(orgId: string, userId: string): Promise<void>;
	/** Write a per-resource grant's permission tuples (replace prior for this grant). */
	syncScopedGrant(grant: ScopedGrant): Promise<void>;
	removeScopedGrant(grant: ScopedGrant): Promise<void>;
	syncHierarchyEdge(edge: HierarchyEdge): Promise<void>;
	removeHierarchyEdge(edge: HierarchyEdge): Promise<void>;
	syncTeamMember(teamId: string, userId: string): Promise<void>;
	removeTeamMember(teamId: string, userId: string): Promise<void>;
	/** Re-expand every grant referencing a role (after its permissions changed). */
	resyncRole(roleId: string): Promise<void>;
	/** Write the model + backfill all tuples from Postgres (idempotent). */
	backfill(): Promise<void>;
}

const NOOP: TupleSync = {
	async syncMemberGrant() {},
	async revokeMemberGrant() {},
	async syncScopedGrant() {},
	async removeScopedGrant() {},
	async syncHierarchyEdge() {},
	async removeHierarchyEdge() {},
	async syncTeamMember() {},
	async removeTeamMember() {},
	async resyncRole() {},
	async backfill() {},
};

/** The active tuple-sync writer — ee's FgaTupleSync when present, else a no-op. */
export function getTupleSync(): TupleSync {
	return getEnterprise()?.tupleSync ?? NOOP;
}

/** Fire-and-forget mirror of a hierarchy edge (Postgres stays authoritative). */
export function mirrorHierarchyEdge(
	childType: string,
	childId: string,
	parentType: string,
	parentId: string,
): void {
	void getTupleSync()
		.syncHierarchyEdge({ childType, childId, parentType, parentId })
		.catch((err) => console.error("[authz] edge tuple sync failed:", err));
}
