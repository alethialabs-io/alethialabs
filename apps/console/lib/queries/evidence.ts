// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import {
	environmentDrift,
	jobs,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import type {
	ExecutionMetadata,
	VerifyOverrideInput,
	VerifyStatus,
	VerifySummary,
} from "@/types/jsonb.types";

// The org-wide "keep proving it" roll-up behind the Evidence surface. Read-only over
// existing tables — no new state. Per environment we surface the latest verification
// verdict (from the most recent PLAN/DEPLOY job's elench report) and the current drift
// posture (environment_drift); org-wide we list the active verification waivers
// (jobs.verify_override). All service-path with an explicit org_id filter, since the
// service role bypasses RLS.

/** The latest verification verdict for an environment, from its most recent PLAN/DEPLOY job. */
export interface EvidenceVerify {
	/** The job whose Plan tab renders the full report + downloadable signed receipt. */
	jobId: string;
	verdict: VerifyStatus;
	/** When the report was produced (job creation time, ISO). */
	evaluatedAt: string;
	/** A signed evidence receipt was sealed to this report. */
	hasReceipt: boolean;
	summary: VerifySummary | null;
}

/** The current drift posture for an environment (latest DETECT_DRIFT scan). */
export interface EvidenceDrift {
	inSync: boolean;
	drifted: number;
	scannedAt: string;
}

/** One environment row in the Verify / Drift tables. */
export interface EvidenceEnvRow {
	projectId: string;
	projectName: string;
	projectSlug: string | null;
	environmentId: string;
	environmentName: string;
	stage: string;
	/** Null when the env has never been verified (a PLAN/DEPLOY carrying a report). */
	verify: EvidenceVerify | null;
	/** Null when the env has never been drift-scanned. */
	drift: EvidenceDrift | null;
}

/** A recorded verification waiver (an authorized, time-boxed control override). */
export interface EvidenceWaiver {
	jobId: string;
	projectName: string | null;
	environmentName: string | null;
	controls: string[];
	reason: string;
	by: string;
	/** RFC3339 expiry, or null for an open-ended waiver. */
	expiry: string | null;
	/** Still in force (no expiry, or expiry in the future). */
	active: boolean;
	createdAt: string;
}

/** Headline counters for the Evidence surface. */
export interface EvidenceSummary {
	environments: number;
	verified: number;
	warning: number;
	failing: number;
	notEvaluable: number;
	/** Environments with no verification on record yet. */
	unverified: number;
	inSync: number;
	drifted: number;
	/** Environments never drift-scanned. */
	driftUnknown: number;
	activeWaivers: number;
}

export interface OrgEvidence {
	rows: EvidenceEnvRow[];
	waivers: EvidenceWaiver[];
	summary: EvidenceSummary;
}

/** Assembles the org-wide evidence roll-up (verify verdicts + drift posture + waivers). */
export async function queryOrgEvidence(orgId: string): Promise<OrgEvidence> {
	const db = getServiceDb();

	const [envs, verifyRows, driftRows, waiverRows] = await Promise.all([
		// Every environment across the org's projects.
		db
			.select({
				environmentId: projectEnvironments.id,
				environmentName: projectEnvironments.name,
				stage: projectEnvironments.stage,
				projectId: projects.id,
				projectName: projects.project_name,
				projectSlug: projects.slug,
			})
			.from(projectEnvironments)
			.innerJoin(projects, eq(projectEnvironments.project_id, projects.id))
			.where(eq(projects.org_id, orgId)),
		// Latest verify-bearing PLAN/DEPLOY job per environment (DISTINCT ON keeps the
		// most recent row per environment_id, newest first).
		db
			.selectDistinctOn([jobs.environment_id], {
				environmentId: jobs.environment_id,
				jobId: jobs.id,
				meta: jobs.execution_metadata,
				createdAt: jobs.created_at,
			})
			.from(jobs)
			.where(
				and(
					eq(jobs.org_id, orgId),
					inArray(jobs.job_type, ["PLAN", "DEPLOY"]),
					isNotNull(jobs.environment_id),
					sql`${jobs.execution_metadata} -> 'verify_result' is not null`,
				),
			)
			.orderBy(jobs.environment_id, desc(jobs.created_at)),
		// Current drift posture per environment (one row per env, upserted each scan).
		db
			.select({
				environmentId: environmentDrift.environment_id,
				inSync: environmentDrift.in_sync,
				drifted: environmentDrift.drifted,
				scannedAt: environmentDrift.scanned_at,
			})
			.from(environmentDrift)
			.innerJoin(projects, eq(environmentDrift.project_id, projects.id))
			.where(eq(projects.org_id, orgId)),
		// Recorded verification waivers, newest first.
		db
			.select({
				jobId: jobs.id,
				override: jobs.verify_override,
				projectName: projects.project_name,
				environmentName: projectEnvironments.name,
				createdAt: jobs.created_at,
			})
			.from(jobs)
			.leftJoin(projects, eq(jobs.project_id, projects.id))
			.leftJoin(
				projectEnvironments,
				eq(jobs.environment_id, projectEnvironments.id),
			)
			.where(and(eq(jobs.org_id, orgId), isNotNull(jobs.verify_override)))
			.orderBy(desc(jobs.created_at))
			.limit(100),
	]);

	// Index the latest verify + drift by environment for the row assembly.
	const verifyByEnv = new Map<string, (typeof verifyRows)[number]>();
	for (const r of verifyRows) {
		if (r.environmentId) verifyByEnv.set(r.environmentId, r);
	}
	const driftByEnv = new Map<string, (typeof driftRows)[number]>();
	for (const r of driftRows) {
		if (r.environmentId) driftByEnv.set(r.environmentId, r);
	}

	const rows: EvidenceEnvRow[] = envs.map((env) => {
		const v = verifyByEnv.get(env.environmentId);
		const report = (v?.meta as ExecutionMetadata | null)?.verify_result ?? null;
		const verify: EvidenceVerify | null =
			v && report
				? {
						jobId: v.jobId,
						verdict: report.verdict,
						evaluatedAt: v.createdAt.toISOString(),
						hasReceipt: Boolean(
							(v.meta as ExecutionMetadata | null)?.verify_receipt,
						),
						summary: report.summary ?? null,
					}
				: null;
		const d = driftByEnv.get(env.environmentId);
		const drift: EvidenceDrift | null = d
			? { inSync: d.inSync, drifted: d.drifted, scannedAt: d.scannedAt.toISOString() }
			: null;
		return {
			projectId: env.projectId,
			projectName: env.projectName,
			projectSlug: env.projectSlug,
			environmentId: env.environmentId,
			environmentName: env.environmentName,
			stage: env.stage,
			verify,
			drift,
		};
	});

	const now = Date.now();
	const waivers: EvidenceWaiver[] = waiverRows
		.filter((w): w is typeof w & { override: VerifyOverrideInput } =>
			Boolean(w.override),
		)
		.map((w) => {
			const o = w.override;
			const active = !o.expiry || new Date(o.expiry).getTime() > now;
			return {
				jobId: w.jobId,
				projectName: w.projectName,
				environmentName: w.environmentName,
				controls: o.controls ?? [],
				reason: o.reason,
				by: o.by,
				expiry: o.expiry ?? null,
				active,
				createdAt: w.createdAt.toISOString(),
			};
		});

	const summary: EvidenceSummary = {
		environments: rows.length,
		verified: rows.filter((r) => r.verify?.verdict === "pass").length,
		warning: rows.filter((r) => r.verify?.verdict === "warn").length,
		failing: rows.filter((r) => r.verify?.verdict === "fail").length,
		notEvaluable: rows.filter((r) => r.verify?.verdict === "not_evaluable")
			.length,
		unverified: rows.filter((r) => !r.verify).length,
		inSync: rows.filter((r) => r.drift?.inSync === true).length,
		drifted: rows.filter((r) => r.drift && !r.drift.inSync).length,
		driftUnknown: rows.filter((r) => !r.drift).length,
		activeWaivers: waivers.filter((w) => w.active).length,
	};

	return { rows, waivers, summary };
}
