"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Bring-your-own (BYO) Helm chart server actions — attach / detach a chart from a connected git
// repo to a project environment, and read the attached charts for the canvas. A BYO chart is
// persisted as a `project_addons` row with source='byo' (chart_repo + chart_path + version=ref);
// the runner renders it as an ArgoCD Application in a hardened per-project "byo-<slug>" AppProject
// on the next DEPLOY. This layer only records intent — it never touches the cluster.
//
// TRUST GATE (MVP): the feature is flagged off by default and, when on, is limited to org-owner-
// authed edits of trusted charts on the org's own cluster. Untrusted third-party charts wait on a
// namespace-PSA + admission-controller (Kyverno/Gatekeeper) gate — see the plan's E2 section.

import { and, eq } from "drizzle-orm";
import { authorize } from "@/lib/authz/guard";
import { getServiceDb, withOwnerScope } from "@/lib/db";
import { type ComponentStatus, jobs, projectAddons } from "@/lib/db/schema";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import { parseValuesYaml } from "@/lib/addons/catalog";
import { isByoHelmEnabled } from "@/lib/addons/byo-flag";
import { notifyScaler } from "@/lib/scaler";
import type { AddOnValues, VerifyReport } from "@/types/jsonb.types";

/** Throws if the feature is disabled — every mutating BYO action calls this first. */
function assertByoHelmEnabled(): void {
	if (!isByoHelmEnabled()) {
		throw new Error(
			"Bring-your-own Helm charts are not enabled on this instance (set ALETHIA_BYO_HELM_ENABLED=true).",
		);
	}
}

/** An attached BYO chart as the canvas reads it back (one per chart node). */
export interface ByoChartState {
	id: string;
	repoUrl: string;
	chartPath: string;
	ref: string;
	namespace: string;
	values: AddOnValues;
	valuesYaml: string | null;
	status: ComponentStatus;
	health: string | null;
	sync: string | null;
	lastSyncedAt: string | null;
	/** Chart-safety scan lifecycle: unscanned | scanning | done | failed. */
	scanStatus: string;
	/** The elench verify.Report over the chart's rendered manifests (null until the first scan). */
	scanReport: VerifyReport | null;
	scannedAt: string | null;
}

/** RFC1123-ish slug for the addon_id of a BYO chart (unique per env), derived from a display name. */
function chartSlug(raw: string): string {
	const s = raw
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return s || "chart";
}

/** Basic sanity on a git repo URL — an https:// or git@ remote. Deep validation happens when the
 * runner clones it; this just rejects obvious garbage at save time. */
function isPlausibleRepoUrl(url: string): boolean {
	return /^https:\/\/\S+$/.test(url) || /^git@\S+:\S+$/.test(url);
}

/**
 * Attaches (or reconfigures) a BYO Helm chart on an environment. Upserts a source='byo'
 * project_addons row as PENDING so the next DEPLOY renders it. `id` is a stable per-env slug
 * (the chart node's id); re-attaching the same id updates it in place.
 */
export async function attachByoChart(input: {
	projectId: string;
	environmentId?: string | null;
	/** Display name / node id → slugified into the addon_id (unique per env). */
	id: string;
	repoUrl: string;
	chartPath: string;
	ref?: string;
	namespace?: string;
	values?: AddOnValues;
	valuesYaml?: string | null;
	gitCredentialId?: string | null;
}): Promise<{ ok: true; id: string }> {
	assertByoHelmEnabled();
	const actor = await authorize("edit", { type: "project", id: input.projectId });

	const id = chartSlug(input.id);
	const repoUrl = input.repoUrl.trim();
	const chartPath = input.chartPath.trim().replace(/^\/+/, "");
	if (!isPlausibleRepoUrl(repoUrl)) {
		throw new Error("Enter a valid git repository URL (https:// or git@…).");
	}
	if (!chartPath) throw new Error("Enter the chart path within the repository.");

	const valuesYaml = input.valuesYaml?.trim() ? input.valuesYaml : null;
	if (valuesYaml && !parseValuesYaml(valuesYaml)) {
		throw new Error("Advanced values must be valid YAML describing a mapping (key: value).");
	}

	const envId = await resolveActiveEnvironmentId(input.projectId, input.environmentId);
	const ref = input.ref?.trim() || "HEAD";
	const namespace = input.namespace?.trim() || "default";
	const values = (input.values ?? {}) as AddOnValues;

	await withOwnerScope(actor.userId, async (tx) => {
		await tx
			.insert(projectAddons)
			.values({
				project_id: input.projectId,
				environment_id: envId,
				addon_id: id,
				source: "byo",
				chart_repo: repoUrl,
				chart_path: chartPath,
				git_credential_id: input.gitCredentialId ?? null,
				enabled: true,
				mode: "managed",
				version: ref,
				values,
				values_yaml: valuesYaml,
				namespace,
				status: "PENDING",
			})
			.onConflictDoUpdate({
				target: [projectAddons.project_id, projectAddons.environment_id, projectAddons.addon_id],
				set: {
					source: "byo",
					chart_repo: repoUrl,
					chart_path: chartPath,
					git_credential_id: input.gitCredentialId ?? null,
					enabled: true,
					mode: "managed",
					version: ref,
					values,
					values_yaml: valuesYaml,
					namespace,
					status: "PENDING",
					updated_at: new Date(),
				},
			});
	});

	// Auto-queue a safety scan so the user sees any issues right after attaching (best-effort — a
	// scan-queue failure must never fail the attach itself).
	try {
		await scanByoChart({ projectId: input.projectId, environmentId: envId, id });
	} catch {
		/* ignore — the chart is attached; the user can re-run the scan from the node */
	}
	return { ok: true, id };
}

/** Detaches a BYO chart (deletes its row); the runner prunes it on the next DEPLOY. */
export async function detachByoChart(input: {
	projectId: string;
	environmentId?: string | null;
	id: string;
}): Promise<{ ok: true }> {
	assertByoHelmEnabled();
	const actor = await authorize("edit", { type: "project", id: input.projectId });
	const envId = await resolveActiveEnvironmentId(input.projectId, input.environmentId);
	await withOwnerScope(actor.userId, async (tx) => {
		await tx
			.delete(projectAddons)
			.where(
				and(
					eq(projectAddons.project_id, input.projectId),
					eq(projectAddons.environment_id, envId),
					eq(projectAddons.addon_id, chartSlug(input.id)),
					eq(projectAddons.source, "byo"),
				),
			);
	});
	return { ok: true };
}

/** Reads the BYO charts attached to an environment — the canvas renders one chart node each. */
export async function getProjectByoCharts(
	projectId: string,
	environmentId?: string | null,
): Promise<{ environmentId: string; charts: ByoChartState[] }> {
	const actor = await authorize("view", { type: "project", id: projectId });
	const envId = await resolveActiveEnvironmentId(projectId, environmentId);
	const rows = await withOwnerScope(actor.userId, async (tx) =>
		tx
			.select()
			.from(projectAddons)
			.where(
				and(
					eq(projectAddons.project_id, projectId),
					eq(projectAddons.environment_id, envId),
					eq(projectAddons.source, "byo"),
				),
			),
	);
	const charts: ByoChartState[] = rows.map((r) => ({
		id: r.addon_id,
		repoUrl: r.chart_repo ?? "",
		chartPath: r.chart_path ?? "",
		ref: r.version ?? "HEAD",
		namespace: r.namespace ?? "default",
		values: r.values ?? {},
		valuesYaml: r.values_yaml,
		status: r.status,
		health: r.health,
		sync: r.sync_status,
		lastSyncedAt: r.last_synced_at?.toISOString() ?? null,
		scanStatus: r.scan_status,
		scanReport: r.scan_report ?? null,
		scannedAt: r.scanned_at?.toISOString() ?? null,
	}));
	return { environmentId: envId, charts };
}

/**
 * Queues a CHART_SCAN job for an attached BYO chart: the runner clones the repo, `helm template`s
 * it, and runs verify.EvaluateManifests over the rendered manifests, posting a verify.Report that
 * finalizeChartScan writes back onto the row. Marks the row `scanning` immediately so the UI can
 * show progress. The job's config_snapshot carries the chart coords (repo_url so the runner's
 * git-token route resolves a token) + the row identity so the result maps back.
 */
export async function scanByoChart(input: {
	projectId: string;
	environmentId?: string | null;
	id: string;
}): Promise<{ ok: true; jobId: string }> {
	assertByoHelmEnabled();
	const actor = await authorize("edit", { type: "project", id: input.projectId });
	const envId = await resolveActiveEnvironmentId(input.projectId, input.environmentId);
	const id = chartSlug(input.id);

	const jobId = await withOwnerScope(actor.userId, async (tx) => {
		const [row] = await tx
			.select()
			.from(projectAddons)
			.where(
				and(
					eq(projectAddons.project_id, input.projectId),
					eq(projectAddons.environment_id, envId),
					eq(projectAddons.addon_id, id),
					eq(projectAddons.source, "byo"),
				),
			)
			.limit(1);
		if (!row || !row.chart_repo || !row.chart_path) {
			throw new Error("Chart not found (attach it before scanning).");
		}
		const [job] = await tx
			.insert(jobs)
			.values({
				user_id: actor.userId,
				org_id: actor.orgId,
				job_type: "CHART_SCAN",
				status: "QUEUED",
				config_snapshot: {
					// repo_url (not chart_repo) so the runner's FetchGitToken route resolves a token.
					repo_url: row.chart_repo,
					chart_path: row.chart_path,
					ref: row.version ?? "HEAD",
					values: row.values ?? {},
					// Row identity for finalizeChartScan → the result maps back to this chart.
					project_id: input.projectId,
					environment_id: envId,
					addon_id: id,
				},
			})
			.returning({ id: jobs.id });
		await tx
			.update(projectAddons)
			.set({ scan_status: "scanning", updated_at: new Date() })
			.where(
				and(
					eq(projectAddons.project_id, input.projectId),
					eq(projectAddons.environment_id, envId),
					eq(projectAddons.addon_id, id),
				),
			);
		return job.id;
	});
	notifyScaler();
	return { ok: true, jobId };
}

/**
 * Writes a finished CHART_SCAN job's verify.Report back onto its chart row (called from the job
 * status route on SUCCESS/FAILED). Uses the service DB (the runner-facing status route has no user
 * session) and maps back via the row identity stashed in config_snapshot.
 */
export async function finalizeChartScan(jobId: string): Promise<void> {
	const db = getServiceDb();
	const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
	if (!job || job.job_type !== "CHART_SCAN") return;
	const snap = (job.config_snapshot ?? {}) as Record<string, unknown>;
	const projectId = typeof snap.project_id === "string" ? snap.project_id : null;
	const environmentId = typeof snap.environment_id === "string" ? snap.environment_id : null;
	const addonId = typeof snap.addon_id === "string" ? snap.addon_id : null;
	if (!projectId || !environmentId || !addonId) return;

	const meta = (job.execution_metadata ?? {}) as { verify_result?: VerifyReport };
	const report = meta.verify_result ?? null;
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
}
