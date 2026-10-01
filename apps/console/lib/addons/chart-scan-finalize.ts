// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Writes a finished CHART_SCAN job's result back onto its BYO chart row, and (dark-launched) the
// workloads the chart renders.
//
// This lives in lib/, NOT in app/server/actions/byo-charts.ts: it is service-role and does not
// authorize, and inside a `"use server"` file every export is a public POST-addressable Server
// Action — callable by anyone with a job id (#5219). Its only caller is the runner-facing job-status
// route, which has already verified the runner token.
//
// Do not add `"use server"` here.

import { and, eq, notInArray } from "drizzle-orm";
import { inferValuePaths } from "@/lib/addons/chart-overlay";
import { isByoDescribeEnabled } from "@/lib/addons/describe-flag";
import { getServiceDb } from "@/lib/db";
import { jobs, projectAddons, projectChartWorkloads } from "@/lib/db/schema";
import { chartWorkloadWireArraySchema } from "@/lib/validations/chart-workloads";

/**
 * Writes a finished CHART_SCAN job's verify.Report back onto its chart row (called from the job
 * status route on SUCCESS/FAILED). Uses the service DB (the runner-facing status route has no user
 * session) and maps back via the row identity stashed in config_snapshot.
 */
export async function finalizeChartScan(jobId: string): Promise<void> {
	const db = getServiceDb();
	const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
	if (!job || job.job_type !== "CHART_SCAN") return;
	const snap = job.config_snapshot ?? {};
	const projectId = typeof snap.project_id === "string" ? snap.project_id : null;
	const environmentId = typeof snap.environment_id === "string" ? snap.environment_id : null;
	const addonId = typeof snap.addon_id === "string" ? snap.addon_id : null;
	if (!projectId || !environmentId || !addonId) return;

	const meta = job.execution_metadata;
	const report = meta?.verify_result ?? null;
	const done = job.status === "SUCCESS" && report !== null;

	await db
		.update(projectAddons)
		.set({
			scan_status: done ? "done" : "failed",
			scan_report: report,
			scanned_at: new Date(),
			updated_at: new Date(),
		})
		.where(
			and(
				eq(projectAddons.project_id, projectId),
				eq(projectAddons.environment_id, environmentId),
				eq(projectAddons.addon_id, addonId),
				eq(projectAddons.source, "byo"),
			),
		);

	// W5 Path A — DESCRIBE: on a clean scan, persist the chart's rendered workloads so the canvas can
	// show + bind them. Dark-launched (ALETHIA_BYO_DESCRIBE_ENABLED). The chart stays the deploy
	// unit — project_chart_workloads never feeds the deploy path, so a described workload can't
	// double-deploy. Only reconciles on SUCCESS (a failed scan keeps the last-known description).
	if (done && isByoDescribeEnabled()) {
		await reconcileChartWorkloads(db, {
			projectId,
			environmentId,
			addonSlug: addonId,
			workloads: meta?.chart_workloads,
		});
	}
}

/**
 * Reconciles the DESCRIBED workloads of a BYO chart into project_chart_workloads from a CHART_SCAN's
 * execution_metadata.chart_workloads wire: validates it, resolves the owning chart addon's uuid,
 * UPSERTs each workload refreshing ONLY the rendered description (the user overlay —
 * bindings/config/value_paths — is preserved across re-scans), then prunes workloads the chart no
 * longer renders. Uses the service DB (the runner-facing status route has no user session).
 */
async function reconcileChartWorkloads(
	db: ReturnType<typeof getServiceDb>,
	args: {
		projectId: string;
		environmentId: string;
		addonSlug: string;
		workloads: unknown;
	},
): Promise<void> {
	const parsed = chartWorkloadWireArraySchema.safeParse(args.workloads ?? []);
	if (!parsed.success) {
		console.error("finalizeChartScan: invalid chart_workloads wire", parsed.error);
		return;
	}
	const workloads = parsed.data;

	// The FK target is the addon's uuid PK; the job only carries the per-env slug.
	const [addon] = await db
		.select({ id: projectAddons.id })
		.from(projectAddons)
		.where(
			and(
				eq(projectAddons.project_id, args.projectId),
				eq(projectAddons.environment_id, args.environmentId),
				eq(projectAddons.addon_id, args.addonSlug),
				eq(projectAddons.source, "byo"),
			),
		)
		.limit(1);
	if (!addon) return;

	for (const w of workloads) {
		await db
			.insert(projectChartWorkloads)
			.values({
				project_id: args.projectId,
				environment_id: args.environmentId,
				addon_id: addon.id,
				name: w.name,
				workload_kind: w.workload_kind,
				rendered: w.rendered,
				// Seed inferred value-paths on first describe (replicaCount/extraEnvVars); the user can
				// override later. On re-scan the set-clause omits value_paths, so overrides survive.
				value_paths: inferValuePaths({
					rendered: w.rendered,
					config: {},
					bindings: [],
				}),
			})
			.onConflictDoUpdate({
				target: [
					projectChartWorkloads.project_id,
					projectChartWorkloads.environment_id,
					projectChartWorkloads.addon_id,
					projectChartWorkloads.name,
				],
				set: {
					workload_kind: w.workload_kind,
					rendered: w.rendered,
					updated_at: new Date(),
				},
			});
	}

	// Prune workloads the chart no longer renders (their overlay is moot once they're gone).
	const names = workloads.map((w) => w.name);
	await db
		.delete(projectChartWorkloads)
		.where(
			names.length > 0
				? and(
						eq(projectChartWorkloads.addon_id, addon.id),
						notInArray(projectChartWorkloads.name, names),
					)
				: eq(projectChartWorkloads.addon_id, addon.id),
		);
}
