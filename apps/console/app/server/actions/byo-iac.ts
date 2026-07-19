"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Bring-your-own (BYO) IaC server actions (E3) — attach / detach a git repo holding an OpenTofu
// ROOT MODULE to a project environment, queue its safety scan, and write the scan result back.
// A BYO IaC source is persisted as a `project_iac_sources` row; while an enabled row exists, that
// environment's PLAN/DEPLOY/DESTROY run the customer's module INSTEAD of the built-in per-cloud
// template (v1 = replace mode; the Go/runner half lands separately). This layer only records
// intent — it never touches the cloud.
//
// TRUST GATE (MVP): flagged off by default (ALETHIA_BYO_IAC_ENABLED). Provisioning is further
// gated on a completed scan whose pinned commit_sha is what actually applies (TOCTOU protection)
// — see assertIacSourceQueueable in projects.ts.

import { and, eq } from "drizzle-orm";
import { signedJob } from "@/lib/db/signed-job";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { authorize } from "@/lib/authz/guard";
import { getServiceDb, type Tx, withActorScope } from "@/lib/db";
import { jobs, projectEnvironments, projectIacSources } from "@/lib/db/schema";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import { isByoIacEnabled } from "@/lib/addons/byo-iac-flag";
import { iacSourceAttachSchema } from "@/lib/validations/byo-iac";
import { notifyScaler } from "@/lib/scaler";
import type { IacScanReport, IacVarValues } from "@/types/jsonb.types";

/**
 * Resolves the Fabric a BYO-IaC source attaches to: the env's `fabric_id`. #839 moved the attach
 * point + the single-stack ceiling from Environment to Fabric (one source per Fabric, shared by
 * every env placed on it). Throws if the env has no Fabric — should not happen post-#836, whose
 * backfill gives every environment a 1:1 Fabric.
 */
async function resolveFabricId(
	tx: Tx,
	projectId: string,
	environmentId: string,
): Promise<string> {
	const [env] = await tx
		.select({ fabric_id: projectEnvironments.fabric_id })
		.from(projectEnvironments)
		.where(
			and(
				eq(projectEnvironments.id, environmentId),
				eq(projectEnvironments.project_id, projectId),
			),
		)
		.limit(1);
	if (!env?.fabric_id) {
		throw new Error(
			"This environment is not linked to a Fabric — cannot attach BYO-IaC.",
		);
	}
	return env.fabric_id;
}

/** Throws if the feature is disabled — every mutating BYO-IaC action calls this first. */
function assertByoIacEnabled(): void {
	if (!isByoIacEnabled()) {
		throw new Error(
			"Bring-your-own IaC is not enabled on this instance (set ALETHIA_BYO_IAC_ENABLED=true).",
		);
	}
}

// Environment statuses that mean template-provisioned cloud state exists (or is in flight /
// possibly half-applied). Attaching a replace-mode IaC source under live template state would
// orphan those resources — the environment must be destroyed first. FAILED counts: a failed
// deploy can leave partial state behind.
const TEMPLATE_STATE_ENV_STATUSES = new Set([
	"QUEUED",
	"PROVISIONING",
	"ACTIVE",
	"FAILED",
	"DESTROYING",
]);

/** An attached BYO IaC source as the UI reads it back. */
export interface IacSourceState {
	id: string;
	environmentId: string;
	name: string;
	repoUrl: string;
	ref: string | null;
	path: string;
	/** The commit pinned by the last successful scan — what a deploy will actually apply. */
	commitSha: string | null;
	/** The commit the last successful DEPLOY applied (live BYO state). null = never deployed. */
	deployedCommitSha: string | null;
	gitCredentialId: string | null;
	varValues: IacVarValues;
	enabled: boolean;
	/** IaC-safety scan lifecycle: unscanned | scanning | done | failed. */
	scanStatus: string;
	scanReport: IacScanReport | null;
	scannedAt: string | null;
	status: string;
	statusMessage: string | null;
}

/**
 * Attaches a BYO IaC source to an environment (v1: at most ONE per environment, replace mode).
 * Rejects when the environment already has a source (detach first) or when the environment has
 * template-provisioned state (destroy first — a replace-mode module would orphan it). The row is
 * created `unscanned`; a scan is auto-queued (best-effort) so provisioning can unlock.
 */
export async function attachIacSource(input: {
	projectId: string;
	environmentId?: string | null;
	repoUrl: string;
	ref?: string | null;
	path?: string;
	gitCredentialId?: string | null;
	varValues?: IacVarValues;
}): Promise<{ ok: true; id: string }> {
	assertByoIacEnabled();
	const actor = await authorize("edit", { type: "project", id: input.projectId });

	const parsed = iacSourceAttachSchema.parse({
		repo_url: input.repoUrl,
		ref: input.ref ?? undefined,
		path: input.path ?? "",
		git_credential_id: input.gitCredentialId ?? undefined,
		var_values: input.varValues ?? {},
	});

	const envId = await resolveActiveEnvironmentId(input.projectId, input.environmentId);

	const id = await withActorScope(actor, async (tx) => {
		// #839: the single-stack ceiling is per-Fabric — reject a second attach onto the same Fabric
		// (a repo swap is an explicit detach + re-attach, which also resets the scan pin). For a
		// `dedicated` env this is the old per-env behaviour; on a shared Fabric, co-Fabric envs share it.
		const fabricId = await resolveFabricId(tx, input.projectId, envId);
		const [existing] = await tx
			.select({ id: projectIacSources.id })
			.from(projectIacSources)
			.where(
				and(
					eq(projectIacSources.project_id, input.projectId),
					eq(projectIacSources.fabric_id, fabricId),
				),
			)
			.limit(1);
		if (existing) {
			throw new Error(
				"This Fabric already has an IaC source attached — detach it before attaching another.",
			);
		}

		// Replace-mode guard: only attach to an environment with no deployed template state.
		const [env] = await tx
			.select({ status: projectEnvironments.status })
			.from(projectEnvironments)
			.where(eq(projectEnvironments.id, envId))
			.limit(1);
		if (env && TEMPLATE_STATE_ENV_STATUSES.has(env.status)) {
			throw new Error(
				"This environment has deployed (or in-flight) template infrastructure. A bring-your-own " +
					"IaC module replaces the built-in template, so destroy the environment first, then attach.",
			);
		}

		const [row] = await tx
			.insert(projectIacSources)
			.values({
				project_id: input.projectId,
				// The attaching env (informational); ownership + the ceiling are on fabric_id.
				environment_id: envId,
				fabric_id: fabricId,
				repo_url: parsed.repo_url,
				ref: parsed.ref ?? null,
				path: parsed.path ?? "",
				git_credential_id: parsed.git_credential_id ?? null,
				var_values: parsed.var_values,
				enabled: true,
			})
			.returning({ id: projectIacSources.id });
		return row.id;
	});

	// Auto-queue the safety scan so provisioning can unlock right after attaching (best-effort —
	// a scan-queue failure must never fail the attach itself; the user can re-run it).
	try {
		await scanIacSource({ projectId: input.projectId, environmentId: envId });
	} catch {
		/* ignore — the source is attached; the user can trigger the scan explicitly */
	}
	return { ok: true, id };
}

/**
 * Detaches an environment's IaC source (deletes the row) — the environment falls back to the
 * built-in template model. Deliberately NOT flag-gated: with the flag off, provisioning of an
 * environment that still has a row is rejected (defense in depth), so detaching must stay
 * possible as the way out (a never-deployed source can always be detached).
 *
 * BUT it IS guarded on DEPLOYED state: once a replace-mode DEPLOY has applied the customer's
 * module (deployed_commit_sha set), or the env is in an active/in-flight status, detaching would
 * drop the only handle to that live BYO infra — a later template deploy would then collide with /
 * orphan it. So destroy first (which clears deployed_commit_sha), then detach. The guard is scoped
 * to DEPLOYED state, not the flag — a source that never deployed stays freely detachable.
 */
export async function detachIacSource(input: {
	projectId: string;
	environmentId?: string | null;
}): Promise<{ ok: true }> {
	const actor = await authorize("edit", { type: "project", id: input.projectId });
	const envId = await resolveActiveEnvironmentId(input.projectId, input.environmentId);
	await withActorScope(actor, async (tx) => {
		const fabricId = await resolveFabricId(tx, input.projectId, envId);
		const [source] = await tx
			.select({ deployed_commit_sha: projectIacSources.deployed_commit_sha })
			.from(projectIacSources)
			.where(
				and(
					eq(projectIacSources.project_id, input.projectId),
					eq(projectIacSources.fabric_id, fabricId),
				),
			)
			.limit(1);
		if (!source) return; // nothing attached — idempotent no-op.

		const [env] = await tx
			.select({ status: projectEnvironments.status })
			.from(projectEnvironments)
			.where(eq(projectEnvironments.id, envId))
			.limit(1);

		const holdsDeployedState =
			source.deployed_commit_sha !== null ||
			(env ? TEMPLATE_STATE_ENV_STATUSES.has(env.status) : false);
		if (holdsDeployedState) {
			throw new Error(
				"This environment has infrastructure deployed from its IaC source — destroy it before detaching.",
			);
		}

		await tx
			.delete(projectIacSources)
			.where(
				and(
					eq(projectIacSources.project_id, input.projectId),
					eq(projectIacSources.fabric_id, fabricId),
				),
			);
	});
	return { ok: true };
}

/** Reads the environment's attached IaC source (null when none). */
export async function getIacSource(
	projectId: string,
	environmentId?: string | null,
): Promise<IacSourceState | null> {
	const actor = await authorize("view", { type: "project", id: projectId });
	const envId = await resolveActiveEnvironmentId(projectId, environmentId);
	const [row] = await withActorScope(actor, async (tx) => {
		const fabricId = await resolveFabricId(tx, projectId, envId);
		return tx
			.select()
			.from(projectIacSources)
			.where(
				and(
					eq(projectIacSources.project_id, projectId),
					eq(projectIacSources.fabric_id, fabricId),
				),
			)
			.limit(1);
	});
	if (!row) return null;
	return {
		id: row.id,
		environmentId: envId,
		name: row.name,
		repoUrl: row.repo_url,
		ref: row.ref,
		path: row.path,
		commitSha: row.commit_sha,
		deployedCommitSha: row.deployed_commit_sha,
		gitCredentialId: row.git_credential_id,
		varValues: row.var_values ?? {},
		enabled: row.enabled,
		scanStatus: row.scan_status,
		scanReport: row.scan_report ?? null,
		scannedAt: row.scanned_at?.toISOString() ?? null,
		status: row.status,
		statusMessage: row.status_message,
	};
}

/**
 * Queues an IAC_SCAN job for the environment's attached IaC source: the runner clones the repo,
 * pins the commit it checked out, inventories the module (providers + module sources) and runs
 * `tofu validate`, posting an IacScanReport that finalizeIacScan writes back onto the row. Marks
 * the row `scanning` immediately so the UI can show progress. The job's config_snapshot carries
 * the repo coords (flat repo_url so the runner's git-token route resolves a token) + the row
 * identity so the result maps back.
 */
export async function scanIacSource(input: {
	projectId: string;
	environmentId?: string | null;
}): Promise<{ ok: true; jobId: string }> {
	assertByoIacEnabled();
	const actor = await authorize("edit", { type: "project", id: input.projectId });
	const envId = await resolveActiveEnvironmentId(input.projectId, input.environmentId);

	await assertJobQuotaAllowed(actor.orgId);
	const jobId = await withActorScope(actor, async (tx) => {
		const fabricId = await resolveFabricId(tx, input.projectId, envId);
		const [row] = await tx
			.select()
			.from(projectIacSources)
			.where(
				and(
					eq(projectIacSources.project_id, input.projectId),
					eq(projectIacSources.fabric_id, fabricId),
				),
			)
			.limit(1);
		if (!row) throw new Error("IaC source not found (attach it before scanning).");
		if (!row.enabled) throw new Error("This IaC source is disabled — enable it before scanning.");

		const [job] = await tx
			.insert(jobs)
			.values(signedJob({
				user_id: actor.userId,
				org_id: actor.orgId,
				job_type: "IAC_SCAN",
				initiated_by: "user",
				status: "QUEUED",
				config_snapshot: {
					// Flat repo_url so the runner's FetchGitToken route resolves a token (the same
					// contract ANALYZE_REPO / CHART_SCAN use).
					repo_url: row.repo_url,
					ref: row.ref ?? undefined,
					path: row.path,
					// Row identity for finalizeIacScan → the result maps back to this source.
					project_id: input.projectId,
					environment_id: envId,
					fabric_id: fabricId,
					iac_source_id: row.id,
				},
			}))
			.returning({ id: jobs.id });
		await tx
			.update(projectIacSources)
			.set({ scan_status: "scanning", updated_at: new Date() })
			.where(eq(projectIacSources.id, row.id));
		return job.id;
	});
	notifyScaler();
	return { ok: true, jobId };
}

/**
 * Writes a finished IAC_SCAN job's report back onto its project_iac_sources row (called from the
 * job status route on SUCCESS/FAILED). Uses the service DB (the runner-facing status route has no
 * user session) and maps back via the row identity stashed in config_snapshot. `done` requires the
 * job to have SUCCEEDED with an ok report — and only then is the scanned commit pinned onto
 * commit_sha (the sha a deploy will actually apply). A not-ok / failed scan clears the pin, so
 * provisioning stays locked until a clean re-scan.
 */
export async function finalizeIacScan(jobId: string): Promise<void> {
	const db = getServiceDb();
	const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
	if (!job || job.job_type !== "IAC_SCAN") return;
	const snap = job.config_snapshot ?? {};
	const projectId = typeof snap.project_id === "string" ? snap.project_id : null;
	const environmentId = typeof snap.environment_id === "string" ? snap.environment_id : null;
	const iacSourceId = typeof snap.iac_source_id === "string" ? snap.iac_source_id : null;
	if (!projectId || !environmentId || !iacSourceId) return;

	const report = job.execution_metadata?.iac_scan_result ?? null;
	const done = job.status === "SUCCESS" && report !== null && report.ok;

	await db
		.update(projectIacSources)
		.set({
			scan_status: done ? "done" : "failed",
			scan_report: report,
			commit_sha: done ? (report?.commit_sha ?? null) : null,
			scanned_at: new Date(),
			updated_at: new Date(),
		})
		.where(
			and(
				eq(projectIacSources.id, iacSourceId),
				eq(projectIacSources.project_id, projectId),
				eq(projectIacSources.environment_id, environmentId),
			),
		);
}
