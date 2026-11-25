// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { and, desc, eq, inArray, isNotNull, isNull, or, type SQL, sql } from "drizzle-orm";
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
import {
	type KeysetListPage,
	type KeysetPageRequest,
	keysetAfter,
	keysetFetchLimit,
	keysetListPage,
	keysetOrderBy,
	keysetPage,
	keysetSortKey,
} from "./keyset";
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
// security posture (environment_security); org-wide we read the IN-FORCE verification waivers
// (jobs.verify_override) the posture needs. The full waiver log — expired ones included — is NOT
// part of the roll-up: it is a list of its own, paged through the keyset contract by
// {@link queryEvidenceWaiversPage} (#7488; it used to ride along here capped at 100 rows, so waiver
// 101 and later were unreachable). All service-path with an explicit org_id filter, since
// the service role bypasses RLS.
//
// EVIDENCE FOLLOWS PROJECT VISIBILITY. Every row belongs to a project, and the roll-up holds only
// the projects in `projectIds` — the reader's PDP answer for `view` on `project`, which the caller
// passes in (lib/rpc/procedures/evidence.ts). That set is intersected with the org's own projects
// here (`projects.org_id = orgId` on every pass), so an id outside the org reads nothing even if
// it were in the set. A waiver recorded on a job with no project and no environment is org-wide,
// as an org-level job is (the job visibility rule, #6121).

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
	/** Still in force: no expiry, or one that parses and is in the future (decided in SQL, `waiverInForce`). */
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

/** One row of the recorded-waivers list: a waiver, keyed by its job for the keyset contract. */
export interface EvidenceWaiverRow extends EvidenceWaiver {
	/** The job that carried the override (= `jobId`) — the list's keyset tiebreaker and row key. */
	id: string;
}

/** One page of the recorded-waivers list. No facets: the list has no filter bar. */
export type EvidenceWaiversPage = KeysetListPage<EvidenceWaiverRow, null>;

export interface OrgEvidence {
	rows: EvidenceEnvRow[];
	/**
	 * The waivers IN FORCE now (no expiry, or one in the future), newest first — every one, uncapped.
	 * What the posture needs: the `waived` status facet, the drawer's per-environment list and the
	 * `activeWaivers` counter. The bound is the waivers that are in force, which expire; the whole log
	 * (expired included) is {@link queryEvidenceWaiversPage}'s.
	 */
	waivers: EvidenceWaiver[];
	summary: EvidenceSummary;
}

/** `col IN (ids)`, or a predicate that matches nothing for an empty set. */
function inIds(col: Parameters<typeof inArray>[0], ids: readonly string[]): SQL {
	return ids.length > 0 ? inArray(col, [...ids]) : sql`false`;
}

/** The visible projects AS PROJECTS OF `orgId` — the pair every pass of the roll-up joins through. */
function visibleProjectOf(orgId: string, projectIds: readonly string[]): SQL | undefined {
	return and(eq(projects.org_id, orgId), inIds(projects.id, projectIds));
}

/** A waiver's `expiry` as stored: free text from the CLI, RFC3339 by contract but not by type. */
const overrideExpiry = sql`(${jobs.verify_override} ->> 'expiry')`;

/**
 * Whether a waiver is in force NOW, decided in SQL so the roll-up can read only the in-force ones and
 * the list can show the same verdict. No (or an empty) expiry is open-ended: in force. An expiry that
 * does not parse as a timestamp is NOT in force (the old in-memory check read it the same way:
 * `new Date("junk") > now` is false). `CASE`, not `AND`: Postgres does not promise to evaluate an
 * `AND`'s operands in order, and the cast raises on a value that does not parse; a `CASE` arm runs
 * only when its condition held. `pg_input_is_valid` is Postgres 16+; every deployment runs 17.
 */
const waiverInForce = sql<boolean>`(case
	when coalesce(${overrideExpiry}, '') = '' then true
	when pg_input_is_valid(${overrideExpiry}, 'timestamptz') then (${overrideExpiry})::timestamptz > now()
	else false
end)`;

/**
 * The waiver scope: jobs of `orgId` carrying an override, on a visible project — or org-level (no
 * project AND no environment), as an org-level job is visible org-wide (the job visibility rule,
 * #6121). Joined to `projects` (left), which this predicate reads.
 */
function waiverScope(orgId: string, projectIds: readonly string[]): SQL | undefined {
	return and(
		eq(jobs.org_id, orgId),
		isNotNull(jobs.verify_override),
		or(visibleProjectOf(orgId, projectIds), and(isNull(jobs.project_id), isNull(jobs.environment_id))),
	);
}

/** The projection both waiver reads select: the override, its labels, its time and its verdict. */
const waiverColumns = {
	jobId: jobs.id,
	override: jobs.verify_override,
	projectName: projects.project_name,
	environmentName: projectEnvironments.name,
	createdAt: jobs.created_at,
	active: waiverInForce,
};

/** A waiver read's row, as {@link waiverColumns} selects it. */
interface WaiverRead {
	jobId: string;
	override: VerifyOverrideInput | null;
	projectName: string | null;
	environmentName: string | null;
	createdAt: Date;
	active: boolean;
}

/**
 * Shapes a waiver read's row. The scope requires a non-null override, so `override` is never null in
 * practice; the column is nullable in the schema, and a null one renders as an empty waiver rather
 * than being dropped, which would shift a keyset page's row count under its cursor.
 */
function toWaiver(w: WaiverRead): EvidenceWaiver {
	const o = w.override;
	return {
		jobId: w.jobId,
		projectName: w.projectName,
		environmentName: w.environmentName,
		controls: o?.controls ?? [],
		reason: o?.reason ?? "",
		by: o?.by ?? "",
		expiry: o?.expiry ? o.expiry : null,
		active: w.active,
		createdAt: w.createdAt.toISOString(),
	};
}

/** The recorded-waivers list's sort key: when the override was recorded, truncated to the ms. */
const waiverSortKey = keysetSortKey(jobs.created_at);

/**
 * The recorded-waivers list, on the console paging contract (lib/query/README.md → "Paging"; #7488):
 * every waiver of the org the reader may see — in force or expired — newest first, the job id
 * breaking ties, `page.limit` rows strictly after `page.cursor`. One rows pass, reading one row more
 * than the page so the end is known exactly. No cap: waiver 101 is one "Load more" away, never cut.
 *
 * No facet pass, because the list has no filter bar (its `facets` is `null` on every page).
 * `universeEmpty` on page one is the page's own answer: with no filter, an empty first page IS an
 * empty scope, so no second read is needed to tell the two empty states apart.
 */
export async function queryEvidenceWaiversPage(
	orgId: string,
	projectIds: readonly string[],
	page: KeysetPageRequest,
): Promise<EvidenceWaiversPage> {
	const fetched = await getServiceDb()
		.select(waiverColumns)
		.from(jobs)
		.leftJoin(projects, eq(jobs.project_id, projects.id))
		.leftJoin(projectEnvironments, eq(jobs.environment_id, projectEnvironments.id))
		.where(and(waiverScope(orgId, projectIds), keysetAfter(waiverSortKey, jobs.id, page.cursor)))
		.orderBy(...keysetOrderBy(waiverSortKey, jobs.id))
		.limit(keysetFetchLimit(page.limit));
	const rows: EvidenceWaiverRow[] = fetched.map((w) => ({ ...toWaiver(w), id: w.jobId }));
	const cut = keysetPage(rows, page.limit, (w) => ({ at: w.createdAt, id: w.id }));
	const first = page.cursor === undefined ? { facets: null, universeEmpty: cut.rows.length === 0 } : null;
	return keysetListPage(cut, first);
}

/**
 * Assembles the evidence roll-up of `orgId` (verify verdicts + drift posture + waivers), limited
 * to the projects in `projectIds` — the ones the reader may view (see the header).
 */
export async function queryOrgEvidence(
	orgId: string,
	projectIds: readonly string[],
): Promise<OrgEvidence> {
	const db = getServiceDb();
	// The visible projects, AS PROJECTS OF THIS ORG: every pass below joins through this pair.
	const visibleProject = visibleProjectOf(orgId, projectIds);
	// The environments of those projects — the only environments a verify row may come from.
	const visibleEnvironments = db
		.select({ id: projectEnvironments.id })
		.from(projectEnvironments)
		.innerJoin(projects, eq(projectEnvironments.project_id, projects.id))
		.where(visibleProject);

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
			.where(visibleProject),
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
					inArray(jobs.environment_id, visibleEnvironments),
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
			.where(visibleProject),
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
			.where(visibleProject),
		// The waivers in force now, newest first — every one (see OrgEvidence.waivers).
		db
			.select(waiverColumns)
			.from(jobs)
			.leftJoin(projects, eq(jobs.project_id, projects.id))
			.leftJoin(
				projectEnvironments,
				eq(jobs.environment_id, projectEnvironments.id),
			)
			.where(and(waiverScope(orgId, projectIds), waiverInForce))
			.orderBy(desc(jobs.created_at), desc(jobs.id)),
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

	const waivers: EvidenceWaiver[] = waiverRows.map(toWaiver);

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
		activeWaivers: waivers.length,
		criticalHighVulns: rows.reduce(
			(n, r) =>
				n + (r.security?.scanned ? r.security.critical + r.security.high : 0),
			0,
		),
		securityUnknown: rows.filter((r) => !r.security?.scanned).length,
	};

	return { rows, waivers, summary };
}
