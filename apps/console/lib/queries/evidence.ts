// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import type { EnvironmentStage } from "@/lib/db/schema/enums";
import {
	cloudIdentities,
	environmentDrift,
	environmentSecurity,
	jobs,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import type {
	DriftDetail,
	ExecutionMetadata,
	SignedReceipt,
	VerifyOverrideInput,
	VerifyReport,
	VerifyStatus,
	VerifySummary,
} from "@/types/jsonb.types";

// The org-wide "keep proving it" roll-up behind the Evidence surface. Read-only over
// existing tables — no new state. Per environment we surface the latest verification
// report + signed receipt (from the most recent PLAN/DEPLOY job's elench result), the
// current drift posture (environment_drift, incl. per-resource details), and the latest
// security posture (environment_security); org-wide we list the active verification
// waivers (jobs.verify_override). All service-path with an explicit org_id filter, since
// the service role bypasses RLS.

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
	/** The full per-control elench report — powers the drawer's Report tab in-place. */
	report: VerifyReport;
	/** The signed evidence receipt sealed to this report, if any (drawer Receipt tab). */
	receipt: SignedReceipt | null;
}

/** The current drift posture for an environment (latest DETECT_DRIFT scan). */
export interface EvidenceDrift {
	inSync: boolean;
	drifted: number;
	scannedAt: string;
	/** Per-resource drift (address/type/kind) — powers the drawer's Drift tab in-place. */
	details: DriftDetail[];
}

/** The current security posture for an environment (latest Trivy scan; L9). `scanned=false`
 * when Trivy-Operator isn't installed. */
export interface EvidenceSecurity {
	critical: number;
	high: number;
	medium: number;
	low: number;
	scanned: boolean;
	scannedAt: string;
	/** Number of VulnerabilityReports that fed the aggregate (a credibility signal). */
	reportCount: number;
}

/** One environment row in the org posture table. */
export interface EvidenceEnvRow {
	projectId: string;
	projectName: string;
	projectSlug: string | null;
	environmentId: string;
	environmentName: string;
	stage: EnvironmentStage;
	/** Cloud provider for the row's logo — the connected identity's provider, falling
	 * back to the verify report's detected provider ("mixed" for multi-cloud plans). */
	provider: string | null;
	/** The environment's region (its own, or the project's when it inherits). */
	region: string;
	/** Null when the env has never been verified (a PLAN/DEPLOY carrying a report). */
	verify: EvidenceVerify | null;
	/** Null when the env has never been drift-scanned. */
	drift: EvidenceDrift | null;
	/** Null when the env has never had a security scan recorded. */
	security: EvidenceSecurity | null;
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
	/** Σ critical + high vulnerabilities across scanned environments. */
	criticalHighVulns: number;
	/** Environments with no Trivy scan on record. */
	securityUnknown: number;
}

export interface OrgEvidence {
	rows: EvidenceEnvRow[];
	waivers: EvidenceWaiver[];
	summary: EvidenceSummary;
}

/** Assembles the org-wide evidence roll-up (verify verdicts + drift posture + waivers). */
export async function queryOrgEvidence(orgId: string): Promise<OrgEvidence> {
	const db = getServiceDb();

	const [envs, verifyRows, driftRows, securityRows, waiverRows] =
		await Promise.all([
		// Every environment across the org's projects (+ the connected identity's
		// provider for the row logo, and the effective region).
		db
			.select({
				environmentId: projectEnvironments.id,
				environmentName: projectEnvironments.name,
				stage: projectEnvironments.stage,
				envRegion: projectEnvironments.region,
				projectId: projects.id,
				projectName: projects.project_name,
				projectSlug: projects.slug,
				projectRegion: projects.region,
				provider: cloudIdentities.provider,
			})
			.from(projectEnvironments)
			.innerJoin(projects, eq(projectEnvironments.project_id, projects.id))
			.leftJoin(
				cloudIdentities,
				eq(projects.cloud_identity_id, cloudIdentities.id),
			)
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
				details: environmentDrift.details,
				scannedAt: environmentDrift.scanned_at,
			})
			.from(environmentDrift)
			.innerJoin(projects, eq(environmentDrift.project_id, projects.id))
			.where(eq(projects.org_id, orgId)),
		// Current security posture per environment (latest Trivy scan; L9).
		db
			.select({
				environmentId: environmentSecurity.environment_id,
				critical: environmentSecurity.critical,
				high: environmentSecurity.high,
				medium: environmentSecurity.medium,
				low: environmentSecurity.low,
				reportCount: environmentSecurity.report_count,
				scanned: environmentSecurity.scanned,
				scannedAt: environmentSecurity.scanned_at,
			})
			.from(environmentSecurity)
			.innerJoin(projects, eq(environmentSecurity.project_id, projects.id))
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
	const securityByEnv = new Map<string, (typeof securityRows)[number]>();
	for (const r of securityRows) {
		if (r.environmentId) securityByEnv.set(r.environmentId, r);
	}

	const rows: EvidenceEnvRow[] = envs.map((env) => {
		const v = verifyByEnv.get(env.environmentId);
		const meta = v?.meta ?? null;
		const report = meta?.verify_result ?? null;
		const verify: EvidenceVerify | null =
			v && report
				? {
						jobId: v.jobId,
						verdict: report.verdict,
						evaluatedAt: v.createdAt.toISOString(),
						hasReceipt: Boolean(meta?.verify_receipt),
						summary: report.summary ?? null,
						report,
						receipt: meta?.verify_receipt ?? null,
					}
				: null;
		const d = driftByEnv.get(env.environmentId);
		const drift: EvidenceDrift | null = d
			? {
					inSync: d.inSync,
					drifted: d.drifted,
					details: d.details ?? [],
					scannedAt: d.scannedAt.toISOString(),
				}
			: null;
		const sec = securityByEnv.get(env.environmentId);
		const security: EvidenceSecurity | null = sec
			? {
					critical: sec.critical,
					high: sec.high,
					medium: sec.medium,
					low: sec.low,
					scanned: sec.scanned,
					scannedAt: sec.scannedAt.toISOString(),
					reportCount: sec.reportCount,
				}
			: null;
		return {
			projectId: env.projectId,
			projectName: env.projectName,
			projectSlug: env.projectSlug,
			environmentId: env.environmentId,
			environmentName: env.environmentName,
			stage: env.stage,
			// The connected identity's provider, else the report's detected provider.
			provider: env.provider ?? report?.provider ?? null,
			region: env.envRegion ?? env.projectRegion,
			verify,
			drift,
			security,
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
		criticalHighVulns: rows.reduce(
			(n, r) =>
				n + (r.security?.scanned ? r.security.critical + r.security.high : 0),
			0,
		),
		securityUnknown: rows.filter((r) => !r.security?.scanned).length,
	};

	return { rows, waivers, summary };
}
