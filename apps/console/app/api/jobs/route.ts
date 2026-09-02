// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "crypto";
import { signedJob } from "@/lib/db/signed-job";
import { type SQL, and, count, desc, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
	destroyProject,
	planProject,
	provisionProject,
} from "@/app/server/actions/projects";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { getActiveScope } from "@/lib/auth/scope";
import { runWithActor } from "@/lib/authz/actor-context";
import { ensureCliOrgAccess } from "@/lib/authz/guard";
import { assertRunnerInOrg } from "@/lib/authz/runner-org";
import { ForbiddenError } from "@/lib/authz/types";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { verifyCliToken } from "@/lib/cli/auth";
import { cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import { jobs, runners, projects } from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";
import { cliJobResponse, cliJobsPageResponse } from "@/lib/validations/cli-contract";

// Job types the CLI is allowed to queue through this endpoint (a subset of the
// full provision_job_type enum — runner-lifecycle types are created elsewhere).
type CreatableJobType = "DEPLOY" | "DESTROY" | "PLAN" | "DESTROY_RUNNER";

/** Narrows an untrusted body value to a CreatableJobType (no cast). */
function parseJobType(v: unknown): CreatableJobType | null {
	switch (v) {
		case "DEPLOY":
		case "DESTROY":
		case "PLAN":
		case "DESTROY_RUNNER":
			return v;
		default:
			return null;
	}
}

/**
 * Queues a provisioning job for the CLI user, snapshotting the project config.
 *
 * PLAN/DEPLOY/DESTROY delegate to the same server actions the console uses
 * (planProject/provisionProject/destroyProject) under the caller's actor
 * (runWithActor — the MCP seam), so a CLI-queued job freezes the SAME nested
 * `buildConfigSnapshot` shape (provider, environment_stage, cluster, dns,
 * addons, placement-resolved components) the Go runner deserializes into
 * ProjectConfig — a nested, placement-resolved snapshot, not a flat per-table row.
 *
 * TENANCY (#3874). Every verb resolves the caller's org before it branches, and the
 * DESTROY_RUNNER insert stamps `jobs.org_id` EXPLICITLY rather than letting the
 * `set_org_id_from_project` trigger fall through. On `getServiceDb()` — a role that
 * bypasses RLS and sets no `app.current_org` — that fallback stamps `NEW.user_id`, so a
 * member of a Teams org filed runner jobs into a personal tenancy nobody looks at. The
 * stamp is taken from the ASSIGNED RUNNER, not from the actor, because `claim_next_job`
 * demands `j.org_id = v_runner_org_id` exactly and #3874 ships no backfill; see the branch
 * comment for why the obvious `actor.orgId` stamp would be worse than the defect.
 * PLAN/DEPLOY/DESTROY are unaffected: they insert through the server actions under
 * `withActorScope`, where the GUC is set and the job derives its org from its project.
 */
export async function POST(req: Request) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) return authError;

	const userId = payload?.sub;
	if (!userId) {
		return NextResponse.json({ error: "Invalid token payload" }, { status: 401 });
	}

	try {
		const body = await req.json();
		const {
			job_type,
			configuration_id,
			cloud_identity_id,
			config_snapshot,
			assigned_runner_id,
			plan_job_id,
			// #837: optional per-environment target. When omitted the server actions fall back to
			// the project's default environment (unchanged back-compat). The CLI wire that sends
			// this is #843; here we only accept + thread it into the placement-aware dispatch.
			environment_id,
		} = body;

		if (!job_type) {
			return NextResponse.json(
				{ error: "job_type is required" },
				{ status: 400 },
			);
		}

		const jobType = parseJobType(job_type);
		if (!jobType) {
			return NextResponse.json(
				{
					error: "job_type must be one of: DEPLOY, DESTROY, PLAN, DESTROY_RUNNER",
				},
				{ status: 400 },
			);
		}

		if ((jobType === "DEPLOY" || jobType === "PLAN") && !configuration_id) {
			return NextResponse.json(
				{ error: "configuration_id is required for DEPLOY and PLAN jobs" },
				{ status: 400 },
			);
		}

		if (jobType === "DESTROY" && !configuration_id) {
			return NextResponse.json(
				{ error: "configuration_id is required for DESTROY jobs" },
				{ status: 400 },
			);
		}

		const db = getServiceDb();

		// EVERY verb resolves its scope here, ABOVE the DESTROY_RUNNER branch (#3874).
		// A SERVICE TOKEN'S ORG WINS OVER THE HEADER, and over the caller's default scope.
		//
		// This route provisions and tears down real cloud infrastructure — and it resolves its
		// own scope rather than going through `authorizeCli`. Without this, a token minted for
		// one org could drive a deploy in another whenever its creator belonged to both: not a
		// cross-tenant escalation, but a containment promise the product makes and would not
		// have kept.
		//
		// This used to sit BELOW the DESTROY_RUNNER branch, so that verb — which destroys a
		// runner — honoured neither `X-Alethia-Org` nor a service token's org pin, and the
		// comment above was true of three of the route's four verbs. Hoisting it is what makes
		// the promise cover the fourth.
		//
		// verifyCliToken already refuses a mismatched header before we get here; the fallback below
		// is what stops an ABSENT header resolving the creator's default org instead.
		const pinnedOrg =
			typeof payload?.service_token_org_id === "string" ? payload.service_token_org_id : undefined;
		const headerOrg = pinnedOrg ?? req.headers.get("X-Alethia-Org")?.trim();
		const actor = await getActiveScope(userId, headerOrg || undefined);
		if (headerOrg) {
			const denied = await ensureCliOrgAccess(actor, userId, headerOrg);
			if (denied) return denied;
		}

		if (jobType === "DESTROY_RUNNER") {
			// Runner teardown has no project config to snapshot — the client sends the
			// runner descriptor as the snapshot. Fail closed (404) on a cross-org /
			// non-existent runner so we never queue an unclaimable job.
			//
			// THE JOB'S ORG FOLLOWS THE RUNNER THAT WILL EXECUTE IT (#3874), which is not the
			// obvious rule. `claim_next_job` compares `j.org_id = v_runner_org_id` as a hard
			// EQUALITY for a self runner (programmables.sql:225 assigned, :306 unassigned), and
			// #3874 stamps forward only — no backfill, so every runner deployed by the CLI before
			// it keeps `org_id = user_id`, the deployer's personal org. Stamping this job with
			// `actor.orgId` regardless would therefore give a team-org job to a personal-org
			// runner: the equality fails, nothing ever claims it, and the job sits QUEUED forever
			// — strictly worse than the personal-org stamp being fixed. So the stamp is READ BACK
			// from the runner the guard just validated, and only falls back to the actor's org
			// where no runner is named (Phase B) or where the runner is managed (`org_id IS NULL`,
			// nobody's tenant — it assumes-role into the job's own org at run time).
			let runnerOrgId: string | null = null;
			if (assigned_runner_id) {
				try {
					// `userId` is the caller's personal org: the transitional admission that keeps a
					// runner deployed before #3874 destroyable. See assertRunnerInOrg's JSDoc.
					runnerOrgId = await assertRunnerInOrg(db, assigned_runner_id, actor.orgId, userId);
				} catch (e: unknown) {
					if (e instanceof ForbiddenError) {
						return NextResponse.json(
							{ error: "Runner not found or unauthorized" },
							{ status: 404 },
						);
					}
					throw e;
				}
			}
			const jobOrgId = runnerOrgId ?? actor.orgId;

			// Counted against the org the row is about to be STAMPED with, not the caller's
			// personal org: the quota query filters `jobs.org_id`, so checking one org and
			// inserting into another measures a tenant this enqueue never joins.
			await assertJobQuotaAllowed(jobOrgId);

			const [job] = await db
				.insert(jobs)
				.values(signedJob({
					user_id: userId,
					// Explicit, so the set_org_id_from_project trigger's `NEW.org_id IS NULL`
					// fallback (→ `NEW.user_id`, since getServiceDb() sets no app.current_org GUC
					// and this row has no project) never runs. That fallback IS the defect.
					org_id: jobOrgId,
					environment_id: null,
					cloud_identity_id: cloud_identity_id || null,
					job_type: jobType,
					initiated_by: "user",
					project_id: null,
					config_snapshot: config_snapshot || {},
					configuration_hash: null,
					status: "QUEUED",
					assigned_runner_id: assigned_runner_id || null,
					plan_job_id: plan_job_id || null,
				}))
				.returning();

			notifyScaler();
			return cliJson(cliJobResponse, { job }, { status: 201 });
		}

		// PLAN / DEPLOY / DESTROY: run the console's own server actions under the CLI
		// caller's actor (resolved above). The actions authorize via the PDP, freeze the nested
		// buildConfigSnapshot, insert the job, flip the env status, audit, and notify
		// the scaler — identical to a console-queued job.
		let jobId: string;
		try {
			const result = await runWithActor(actor, async () => {
				switch (jobType) {
					case "PLAN":
						return planProject(
							configuration_id,
							assigned_runner_id || null,
							environment_id || null,
						);
					case "DEPLOY":
						return provisionProject(
							configuration_id,
							plan_job_id || undefined,
							assigned_runner_id || null,
							environment_id || null,
						);
					case "DESTROY":
						return destroyProject(
							configuration_id,
							environment_id || null,
							assigned_runner_id || null,
						);
				}
			});
			jobId = result.jobId;
		} catch (e: unknown) {
			// The PDP denies both "not yours" and "does not exist" — keep the CLI's
			// historical 404 contract for that case.
			if (e instanceof ForbiddenError) {
				return NextResponse.json(
					{ error: "Configuration not found or unauthorized" },
					{ status: 404 },
				);
			}
			throw e;
		}

		const [inserted] = await db
			.select()
			.from(jobs)
			.where(eq(jobs.id, jobId))
			.limit(1);
		if (!inserted) {
			return NextResponse.json({ error: "Job not found after queue" }, { status: 500 });
		}

		// Preserve the CLI plan→apply drift guard: the runner compares the PLAN job's
		// configuration_hash against the DEPLOY job's before applying.
		const configHash = createHash("sha256")
			.update(JSON.stringify(inserted.config_snapshot))
			.digest("hex");
		const [job] = await db
			.update(jobs)
			.set({ configuration_hash: configHash })
			.where(eq(jobs.id, jobId))
			.returning();

		// Ops alert (free): a teardown was requested. org_id is trigger-populated on insert.
		if (jobType === "DESTROY" && job.org_id) {
			emitAlertEventSafe(job.org_id, "system.job.destroy_requested", {
				title: "Destroy requested",
				severity: "warning",
				job_id: job.id,
				job_type: "DESTROY",
				project_id: configuration_id,
			});
		}

		return cliJson(cliJobResponse, { job }, { status: 201 });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

/** Lists the CLI user's jobs with the project project name + runner name attached. */
export async function GET(req: Request) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) return authError;

	const userId = payload?.sub;
	if (!userId) {
		return NextResponse.json({ error: "Invalid token payload" }, { status: 401 });
	}

	const { searchParams } = new URL(req.url);
	const status = searchParams.get("status");
	const limit = Math.min(parseInt(searchParams.get("limit") || "20", 10), 100);
	const offset = parseInt(searchParams.get("offset") || "0", 10);

	const db = getServiceDb();

	const conds: SQL[] = [eq(jobs.user_id, userId)];
	if (status) conds.push(sql`${jobs.status}::text = ${status}`);
	const whereExpr = and(...conds);

	const rows = await db
		.select({
			job: jobs,
			project_name: projects.project_name,
			runner_name: runners.name,
		})
		.from(jobs)
		.leftJoin(projects, eq(jobs.project_id, projects.id))
		.leftJoin(runners, eq(jobs.runner_id, runners.id))
		.where(whereExpr)
		.orderBy(desc(jobs.created_at))
		.limit(limit)
		.offset(offset);

	const [{ value: total }] = await db
		.select({ value: count() })
		.from(jobs)
		.where(whereExpr);

	const result = rows.map((r) => ({
		...r.job,
		project_name: r.project_name ?? null,
		runner_name: r.runner_name ?? null,
	}));

	return cliJson(cliJobsPageResponse, { jobs: result, total, limit, offset });
}
