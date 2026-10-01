// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Records the day-2 drift posture a DETECT_DRIFT job reported, per environment and per Fabric.
//
// This lives in lib/, NOT in app/server/actions/drift.ts: both writes are service-role and do not
// authorize, and inside a `"use server"` file every export is a public POST-addressable Server
// Action — so anyone could overwrite any project's posture, including marking a drifted environment
// in sync (#5219). Their only caller is the runner-facing job-status route, which has already
// verified the runner token. The READS stay in the actions file, PDP-gated.
//
// Do not add `"use server"` here.

import { getServiceDb } from "@/lib/db";
import { environmentDrift, fabricDrift } from "@/lib/db/schema";
import type { DriftDetail } from "@/types/jsonb.types";

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
