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
import { withOwnerScope } from "@/lib/db";
import { type ComponentStatus, projectAddons } from "@/lib/db/schema";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import { parseValuesYaml } from "@/lib/addons/catalog";
import type { AddOnValues } from "@/types/jsonb.types";

/** Whether the BYO-Helm feature is enabled on this deployment (trusted-only MVP gate). Off unless
 * the operator explicitly opts in via ALETHIA_BYO_HELM_ENABLED=true. */
export function isByoHelmEnabled(): boolean {
	return process.env.ALETHIA_BYO_HELM_ENABLED === "true";
}

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
	}));
	return { environmentId: envId, charts };
}
