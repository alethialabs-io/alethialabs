"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, desc, eq } from "drizzle-orm";
import { authorize } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { environmentDrift, fabricDrift, projects } from "@/lib/db/schema";
import type { DriftDetail } from "@/types/jsonb.types";

/** The day-2 drift posture of a project environment (the read shape). */
export interface DriftPosture {
	inSync: boolean;
	drifted: number;
	details: DriftDetail[];
	scannedAt: string;
}

/**
 * Latest drift posture for a project (optionally scoped to one environment). PDP-gated
 * (view). Returns null when no DETECT_DRIFT job has run yet. Read by the project UI, the
 * assistant (`get_drift_posture`), and — via the tool audience — external MCP agents.
 */
export async function getLatestDriftPosture(
	projectId: string,
	environmentId?: string | null,
): Promise<DriftPosture | null> {
	const actor = await authorize("view", { type: "project", id: projectId });
	// `environment_drift` is an RLS-less project-child table, so the org boundary is
	// enforced HERE, not by a policy: join to the parent project and filter on the
	// caller's org (mirrors lib/queries/evidence.ts queryOrgEvidence). The service db
	// bypasses RLS, so the explicit `projects.org_id = actor.orgId` predicate is the
	// tenancy wall — a foreign project UUID returns no row even though the PDP grant
	// (org-wide `project:view`) let authorize() through. Using actor.orgId (not
	// withOwnerScope on actor.userId) keeps it correct for Teams orgs, where a
	// teammate's project has org_id = the org but user_id = another member.
	const db = getServiceDb();
	const rows = await db
		.select({
			in_sync: environmentDrift.in_sync,
			drifted: environmentDrift.drifted,
			details: environmentDrift.details,
			scanned_at: environmentDrift.scanned_at,
		})
		.from(environmentDrift)
		.innerJoin(projects, eq(environmentDrift.project_id, projects.id))
		.where(
			and(
				eq(environmentDrift.project_id, projectId),
				eq(projects.org_id, actor.orgId),
				...(environmentId
					? [eq(environmentDrift.environment_id, environmentId)]
					: []),
			),
		)
		.orderBy(desc(environmentDrift.scanned_at))
		.limit(1);
	const r = rows[0];
	if (!r) return null;
	return {
		inSync: r.in_sync,
		drifted: r.drifted,
		details: r.details ?? [],
		scannedAt: r.scanned_at.toISOString(),
	};
}

/**
 * Upsert a project environment's drift posture. Called by the runner (service role)
 * after a DETECT_DRIFT job runs `tofu plan -refresh-only -json` → `drift.Analyze`.
 * Latest-wins per (project, environment).
 */
export async function recordDriftPosture(input: {
	projectId: string;
	environmentId: string | null;
	inSync: boolean;
	drifted: number;
	details: DriftDetail[];
	scannedAt: string;
}): Promise<void> {
	const db = getServiceDb();
	await db
		.insert(environmentDrift)
		.values({
			project_id: input.projectId,
			environment_id: input.environmentId,
			in_sync: input.inSync,
			drifted: input.drifted,
			details: input.details,
			scanned_at: new Date(input.scannedAt),
			updated_at: new Date(),
		})
		.onConflictDoUpdate({
			target: [environmentDrift.project_id, environmentDrift.environment_id],
			set: {
				in_sync: input.inSync,
				drifted: input.drifted,
				details: input.details,
				scanned_at: new Date(input.scannedAt),
				updated_at: new Date(),
			},
		});
}

/**
 * Latest INFRA drift posture for a Fabric (#841). Infra drift is per-Fabric: the Fabric owns the
 * tofu state (#838), so its refresh-only divergence belongs here, not to a delivery Environment.
 * PDP-gated (view); tenancy is walled by the parent-project org join exactly like
 * `getLatestDriftPosture` (`fabric_drift` is RLS-less). Returns null when no DETECT_DRIFT has run.
 */
export async function getLatestFabricDrift(
	projectId: string,
	fabricId: string,
): Promise<DriftPosture | null> {
	const actor = await authorize("view", { type: "project", id: projectId });
	const db = getServiceDb();
	const rows = await db
		.select({
			in_sync: fabricDrift.in_sync,
			drifted: fabricDrift.drifted,
			details: fabricDrift.details,
			scanned_at: fabricDrift.scanned_at,
		})
		.from(fabricDrift)
		.innerJoin(projects, eq(fabricDrift.project_id, projects.id))
		.where(
			and(
				eq(fabricDrift.project_id, projectId),
				eq(fabricDrift.fabric_id, fabricId),
				eq(projects.org_id, actor.orgId),
			),
		)
		.orderBy(desc(fabricDrift.scanned_at))
		.limit(1);
	const r = rows[0];
	if (!r) return null;
	return {
		inSync: r.in_sync,
		drifted: r.drifted,
		details: r.details ?? [],
		scannedAt: r.scanned_at.toISOString(),
	};
}

/**
 * Upsert a Fabric's INFRA drift posture (#841). Called by the job-status route (service role) after a
 * DETECT_DRIFT job whose snapshot carries a `fabric_id` runs its refresh-only plan. Latest-wins per
 * (project, fabric). For a `dedicated` placement (env owns its Fabric 1:1) this mirrors the
 * `environment_drift` row; for a shared placement it is the single per-Fabric infra truth.
 */
export async function recordFabricDriftPosture(input: {
	projectId: string;
	fabricId: string;
	inSync: boolean;
	drifted: number;
	details: DriftDetail[];
	scannedAt: string;
}): Promise<void> {
	const db = getServiceDb();
	await db
		.insert(fabricDrift)
		.values({
			project_id: input.projectId,
			fabric_id: input.fabricId,
			in_sync: input.inSync,
			drifted: input.drifted,
			details: input.details,
			scanned_at: new Date(input.scannedAt),
			updated_at: new Date(),
		})
		.onConflictDoUpdate({
			target: [fabricDrift.project_id, fabricDrift.fabric_id],
			set: {
				in_sync: input.inSync,
				drifted: input.drifted,
				details: input.details,
				scanned_at: new Date(input.scannedAt),
				updated_at: new Date(),
			},
		});
}
