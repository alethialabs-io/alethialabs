"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, desc, eq } from "drizzle-orm";
import { authorize } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { environmentDrift, projects } from "@/lib/db/schema";
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
