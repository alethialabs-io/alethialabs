// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { and, eq } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import {
	type ComponentStatus,
	environmentSecurity,
	projectAddons,
} from "@/lib/db/schema";
import type { AddOnStatusEntry, SecurityReport } from "@/types/jsonb.types";

// Shared persistence for cluster-inspection results (ArgoCD add-on health + Trivy security
// posture). Written by both the DEPLOY finalizer (deployments.ts) and the day-2 DETECT_DRIFT
// status route, so a deploy and a drift sweep update the same rows identically. Service path
// (BYPASSRLS) — the caller is runner-triggered and scopes by project + environment.

/** Maps an ArgoCD health status onto the component status the add-ons UI shows. */
export function addonComponentStatus(health: string): ComponentStatus {
	if (health === "Healthy") return "ACTIVE";
	if (health === "Degraded" || health === "Missing") return "FAILED";
	// Progressing / Suspended / Unknown → still converging.
	return "CREATING";
}

/**
 * Persists per-add-on ArgoCD health/sync for an environment. `addonStatus` is keyed by the
 * ArgoCD Application name ("addon-<id>"); the prefix is stripped to match
 * `project_addons.addon_id`. Only updates rows that exist (an add-on must be enabled first).
 */
export async function recordAddonHealth(
	projectId: string,
	environmentId: string,
	addonStatus: Record<string, AddOnStatusEntry>,
): Promise<void> {
	const db = getServiceDb();
	const now = new Date();
	for (const [appName, s] of Object.entries(addonStatus)) {
		const addonId = appName.replace(/^addon-/, "");
		await db
			.update(projectAddons)
			.set({
				health: s.health,
				sync_status: s.sync,
				status: addonComponentStatus(s.health),
				last_synced_at: now,
				updated_at: now,
			})
			.where(
				and(
					eq(projectAddons.project_id, projectId),
					eq(projectAddons.environment_id, environmentId),
					eq(projectAddons.addon_id, addonId),
				),
			);
	}
}

/** Upserts the cluster's Trivy vulnerability posture (L9) for an environment. */
export async function recordSecurityPosture(
	projectId: string,
	environmentId: string,
	report: SecurityReport,
): Promise<void> {
	const db = getServiceDb();
	const now = new Date();
	await db
		.insert(environmentSecurity)
		.values({
			project_id: projectId,
			environment_id: environmentId,
			critical: report.critical,
			high: report.high,
			medium: report.medium,
			low: report.low,
			report_count: report.report_count,
			scanned: report.scanned,
			scanned_at: now,
		})
		.onConflictDoUpdate({
			target: [
				environmentSecurity.project_id,
				environmentSecurity.environment_id,
			],
			set: {
				critical: report.critical,
				high: report.high,
				medium: report.medium,
				low: report.low,
				report_count: report.report_count,
				scanned: report.scanned,
				scanned_at: now,
				updated_at: now,
			},
		});
}
