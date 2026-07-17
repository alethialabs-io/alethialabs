// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The GitOps deploy-status read model (#574) — ONE server-side assembly both surfaces
// (the artifact panel's Deploy tab and the canvas badges via EnvironmentStatus) read,
// so they can never disagree. Sources: the latest DEPLOY job's `gitops_status`
// execution_metadata (wiring outcome), the latest successful DETECT_DRIFT's snapshot
// (day-2 freshness), `project_repositories`/`project_cluster`/`project_environments`
// wiring facts, `project_addons` health columns, and the in-cluster data-service keys
// of `addon_status`. No new DB columns — everything rides existing storage.
//
// Fail-loud rules encoded here:
// - `failed_step` set on the latest deploy ⇒ the wiring died before any health read:
//   service rows render Unknown (`statusAvailable=false`), NEVER a stale pass.
// - Pre-#574 jobs carry no `gitops_status` ⇒ mode is inferred from the repo row, and
//   services are honestly Unknown until the next deploy populates the snapshot.
// - Add-ons/data services keep their own refresh channel (`recordAddonHealth`, day-2
//   DETECT_DRIFT → project_addons columns), so they stay real even when the latest
//   deploy failed — a first failed deploy has no health rows and reads Unknown anyway.

import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getServiceDb } from "@/lib/db";
import {
	jobs,
	projectAddons,
	projectCluster,
	projectEnvironments,
	projectRepositories,
	projectServices,
} from "@/lib/db/schema";
import type { ExecutionMetadata, GitopsStatusReport } from "@/types/jsonb.types";

/** Wire-shape validator for `execution_metadata.gitops_status` (Go `argocd.GitopsStatus`).
 *  Every field beyond `mode` is optional so pre-#574 and partial payloads parse. */
export const gitopsStatusReportSchema = z.object({
	mode: z.enum(["gitops", "direct"]),
	apps_repo: z.string().optional(),
	argocd_app: z.string().optional(),
	revision: z.string().optional(),
	failed_step: z.string().optional(),
	error: z.string().optional(),
	app_health: z.object({ health: z.string(), sync: z.string() }).optional(),
	services: z
		.record(
			z.string(),
			z.object({
				health: z.string(),
				sync: z.string(),
				message: z.string().optional(),
			}),
		)
		.optional(),
	manifest_warnings: z.array(z.string()).optional(),
});

/** One component row on the Deploy tab: ArgoCD health + sync + optional message. */
export interface GitopsComponentRow {
	name: string;
	/** Healthy | Progressing | Degraded | Suspended | Missing | Unknown. */
	health: string;
	/** Synced | OutOfSync | Unknown. */
	sync: string;
	message: string | null;
}

/** The assembled Deploy-tab read model for one environment. */
export interface GitopsDeployStatus {
	/** "gitops" when an apps repo is wired, "direct" otherwise (inferred from the repo
	 *  row for pre-#574 jobs that carry no snapshot). */
	mode: "gitops" | "direct";
	appsRepo: string | null;
	/** The ArgoCD Application syncing the apps repo ("apps"); null in direct mode. */
	argocdApp: string | null;
	argocdUrl: string | null;
	/** The apps Application's synced commit SHA; null when unread. */
	revision: string | null;
	/** env.last_deployed_at (ISO); null = never successfully deployed. */
	lastDeployAt: string | null;
	/** The latest DEPLOY job ended FAILED. */
	lastDeployFailed: boolean;
	/** Set ⇒ the latest deploy died INSIDE the GitOps wiring (the failure banner). One of
	 *  argocd_install | git_token | repo_credentials | templates_missing | render | apply. */
	failedStep: string | null;
	/** The wiring failure message (token-sanitized in Go), else the job's error_message. */
	failureMessage: string | null;
	/** False ⇒ no trustworthy service snapshot exists (wiring failed before the health
	 *  read, or a pre-#574 job): service rows render Unknown — never a stale pass. */
	statusAvailable: boolean;
	/** GitOps-managed workloads from the apps Application (union of designed services
	 *  and the snapshot's workloads). Empty in direct mode. */
	services: GitopsComponentRow[];
	/** Marketplace add-ons (project_addons — day-2 refreshed by recordAddonHealth). */
	addons: GitopsComponentRow[];
	/** In-cluster data services (the addon-db-/cache-/queue- keys of addon_status).
	 *  Cloud-managed data services live on the canvas, not here. */
	dataServices: GitopsComponentRow[];
	/** Non-fatal warnings from the LATEST deploy's manifest generation: a skipped service, an
	 *  unresolved binding endpoint (#710), an unsatisfiable credential facet — why a rendered
	 *  service may boot misconfigured. Empty ⇒ generation was clean (or bring-your-own). */
	warnings: string[];
}

/** The empty read model — an environment that has never been deployed. */
export const EMPTY_GITOPS_DEPLOY_STATUS: GitopsDeployStatus = {
	mode: "direct",
	appsRepo: null,
	argocdApp: null,
	argocdUrl: null,
	revision: null,
	lastDeployAt: null,
	lastDeployFailed: false,
	failedStep: null,
	failureMessage: null,
	statusAvailable: false,
	services: [],
	addons: [],
	dataServices: [],
	warnings: [],
};

/** A gitops-carrying job reduced to what assembly needs. */
export interface GitopsJobFacts {
	status: string;
	errorMessage: string | null;
	createdAt: Date;
	gitops: GitopsStatusReport | null;
	/** `execution_metadata.addon_status` — carries the in-cluster data-service keys. */
	addonStatus: Record<string, { health: string; sync: string }> | null;
}

/** Everything assembleGitopsDeployStatus needs — pure inputs, so the scenario matrix
 *  is unit-testable without a database. */
export interface GitopsAssemblyInputs {
	appsRepo: string | null;
	argocdUrl: string | null;
	lastDeployedAt: Date | null;
	/** Latest terminal DEPLOY job (any outcome); null = never deployed. */
	deployJob: GitopsJobFacts | null;
	/** Latest SUCCESS DETECT_DRIFT job — the day-2 snapshot channel. */
	driftJob: GitopsJobFacts | null;
	/** Designed service names (project_services) — skeleton rows even when unread. */
	designedServices: string[];
	/** Enabled add-on rows with their day-2-refreshed ArgoCD columns. */
	addonRows: { addonId: string; health: string | null; sync: string | null; message: string | null }[];
}

const UNKNOWN = "Unknown";

/** In-cluster data services ride addon_status under these key prefixes (Go AllAddOnNames). */
const DATA_SERVICE_PREFIXES = ["addon-db-", "addon-cache-", "addon-queue-"] as const;

/**
 * Assemble the Deploy-tab read model from its raw inputs. Pure — the scenario matrix
 * (healthy / mixed / failed-wiring / direct / pre-#574) is locked by unit tests.
 */
export function assembleGitopsDeployStatus(inputs: GitopsAssemblyInputs): GitopsDeployStatus {
	const { deployJob, driftJob } = inputs;

	// The freshest health snapshot wins: a successful day-2 drift read is newer truth
	// than the last deploy's read. Wiring facts (mode / failure) always come from the
	// latest DEPLOY — drift never carries a failed_step.
	const driftIsFresher =
		driftJob?.gitops && (!deployJob || driftJob.createdAt > deployJob.createdAt);
	const snapshot = driftIsFresher ? driftJob.gitops : (deployJob?.gitops ?? null);

	const mode: "gitops" | "direct" =
		snapshot?.mode ?? (inputs.appsRepo ? "gitops" : "direct");
	const appsRepo = snapshot?.apps_repo ?? inputs.appsRepo;

	const lastDeployFailed = deployJob?.status === "FAILED";
	// The failure banner keys off the LATEST deploy only: an old wiring failure that a
	// later deploy fixed must not resurface.
	const failedStep = lastDeployFailed ? (deployJob?.gitops?.failed_step ?? null) : null;
	const failureMessage = failedStep
		? (deployJob?.gitops?.error ?? deployJob?.errorMessage ?? null)
		: null;

	// Fail-loud: a trustworthy service snapshot exists only when SOME gitops-carrying
	// job succeeded past the wiring. A failed wiring or a pre-#574 job ⇒ Unknown rows.
	const statusAvailable = !!snapshot && !snapshot.failed_step;

	// Services: union of the designed set and the snapshot's workloads, so a designed
	// service that never reached the repo still gets an honest Unknown row.
	const services: GitopsComponentRow[] = [];
	if (mode === "gitops") {
		const snapshotServices = statusAvailable ? (snapshot?.services ?? {}) : {};
		const names = new Set<string>([
			...inputs.designedServices,
			...Object.keys(snapshotServices),
		]);
		for (const name of [...names].sort()) {
			const entry = snapshotServices[name];
			services.push({
				name,
				health: entry?.health ?? UNKNOWN,
				sync: entry?.sync ?? UNKNOWN,
				message: entry?.message || null,
			});
		}
	}

	const addons: GitopsComponentRow[] = inputs.addonRows
		.map((row) => ({
			name: row.addonId,
			health: row.health ?? UNKNOWN,
			sync: row.sync ?? UNKNOWN,
			message: row.message,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));

	// In-cluster data services: present only in addon_status metadata (their synthesized
	// specs have no project_addons rows). Freshest metadata wins, same rule as above.
	const addonStatus =
		(driftIsFresher ? driftJob?.addonStatus : deployJob?.addonStatus) ??
		deployJob?.addonStatus ??
		null;
	const dataServices: GitopsComponentRow[] = Object.entries(addonStatus ?? {})
		.filter(([key]) => DATA_SERVICE_PREFIXES.some((p) => key.startsWith(p)))
		.map(([key, entry]) => ({
			name: key.replace(/^addon-/, ""),
			health: entry.health || UNKNOWN,
			sync: entry.sync || UNKNOWN,
			message: null,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));

	return {
		mode,
		appsRepo: mode === "gitops" ? appsRepo : null,
		argocdApp: mode === "gitops" ? (snapshot?.argocd_app ?? "apps") : null,
		argocdUrl: inputs.argocdUrl,
		revision: statusAvailable ? (snapshot?.revision || null) : null,
		lastDeployAt: inputs.lastDeployedAt?.toISOString() ?? null,
		lastDeployFailed,
		failedStep,
		failureMessage,
		statusAvailable,
		services,
		addons,
		dataServices,
		// Manifest-generation warnings are a DEPLOY-time artifact (drift never regenerates), so they
		// come from the latest deploy's snapshot — valid until the next deploy re-renders.
		warnings: deployJob?.gitops?.manifest_warnings ?? [],
	};
}

/** Parse a job row's metadata into GitopsJobFacts; malformed payloads degrade to null. */
function jobFacts(row: {
	status: string;
	error_message: string | null;
	created_at: Date;
	execution_metadata: ExecutionMetadata | null;
}): GitopsJobFacts {
	const meta = row.execution_metadata;
	const gitops = gitopsStatusReportSchema.safeParse(meta?.gitops_status);
	const addonStatus = z
		.record(z.string(), z.object({ health: z.string(), sync: z.string() }))
		.safeParse(meta?.addon_status);
	return {
		status: row.status,
		errorMessage: row.error_message,
		createdAt: row.created_at,
		gitops: gitops.success ? gitops.data : null,
		addonStatus: addonStatus.success ? addonStatus.data : null,
	};
}

/**
 * Read + assemble the Deploy-tab model for one environment. TENANCY: callers must have
 * verified env ∈ project ∈ caller's org (the server actions do the projects join) —
 * this helper only scopes by project/environment ids, like getIacEnvironment.
 */
export async function readGitopsDeployStatus(
	projectId: string,
	environmentId: string,
): Promise<GitopsDeployStatus> {
	const db = getServiceDb();

	const [repoRow, clusterRow, envRow, deployRow, driftRow, serviceRows, addonRows] =
		await Promise.all([
			db
				.select({ apps_destination_repo: projectRepositories.apps_destination_repo })
				.from(projectRepositories)
				.where(
					and(
						eq(projectRepositories.project_id, projectId),
						eq(projectRepositories.environment_id, environmentId),
					),
				)
				.limit(1)
				.then((r) => r[0]),
			db
				.select({ argocd_url: projectCluster.argocd_url })
				.from(projectCluster)
				.where(
					and(
						eq(projectCluster.project_id, projectId),
						eq(projectCluster.environment_id, environmentId),
					),
				)
				.limit(1)
				.then((r) => r[0]),
			db
				.select({ last_deployed_at: projectEnvironments.last_deployed_at })
				.from(projectEnvironments)
				.where(eq(projectEnvironments.id, environmentId))
				.limit(1)
				.then((r) => r[0]),
			db
				.select({
					status: jobs.status,
					error_message: jobs.error_message,
					created_at: jobs.created_at,
					execution_metadata: jobs.execution_metadata,
				})
				.from(jobs)
				.where(
					and(
						eq(jobs.project_id, projectId),
						eq(jobs.environment_id, environmentId),
						eq(jobs.job_type, "DEPLOY"),
						inArray(jobs.status, ["SUCCESS", "FAILED", "CANCELLED"]),
					),
				)
				.orderBy(desc(jobs.created_at))
				.limit(1)
				.then((r) => r[0]),
			db
				.select({
					status: jobs.status,
					error_message: jobs.error_message,
					created_at: jobs.created_at,
					execution_metadata: jobs.execution_metadata,
				})
				.from(jobs)
				.where(
					and(
						eq(jobs.project_id, projectId),
						eq(jobs.environment_id, environmentId),
						eq(jobs.job_type, "DETECT_DRIFT"),
						eq(jobs.status, "SUCCESS"),
					),
				)
				.orderBy(desc(jobs.created_at))
				.limit(1)
				.then((r) => r[0]),
			db
				.select({ name: projectServices.name })
				.from(projectServices)
				.where(
					and(
						eq(projectServices.project_id, projectId),
						eq(projectServices.environment_id, environmentId),
					),
				),
			db
				.select({
					addon_id: projectAddons.addon_id,
					health: projectAddons.health,
					sync_status: projectAddons.sync_status,
					status_message: projectAddons.status_message,
				})
				.from(projectAddons)
				.where(
					and(
						eq(projectAddons.project_id, projectId),
						eq(projectAddons.environment_id, environmentId),
						eq(projectAddons.enabled, true),
					),
				),
		]);

	return assembleGitopsDeployStatus({
		appsRepo: repoRow?.apps_destination_repo ?? null,
		argocdUrl: clusterRow?.argocd_url ?? null,
		lastDeployedAt: envRow?.last_deployed_at ?? null,
		deployJob: deployRow ? jobFacts(deployRow) : null,
		driftJob: driftRow ? jobFacts(driftRow) : null,
		designedServices: serviceRows.map((r) => r.name),
		addonRows: addonRows.map((r) => ({
			addonId: r.addon_id,
			health: r.health,
			sync: r.sync_status,
			message: r.status_message,
		})),
	});
}
