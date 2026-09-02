// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "crypto";
import { signedJob } from "@/lib/db/signed-job";
import { type SQL, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
	destroyProject,
	planProject,
	provisionProject,
} from "@/app/server/actions/projects";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { getActiveScope } from "@/lib/auth/scope";
import { runWithActor } from "@/lib/authz/actor-context";
import { authorizeCli, ensureCliOrgAccess } from "@/lib/authz/guard";
import { assertRunnerInOrg } from "@/lib/authz/runner-org";
import { ForbiddenError } from "@/lib/authz/types";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { verifyCliToken } from "@/lib/cli/auth";
import {
	type CursorScope,
	cursorKey,
	paginate,
	parsePageOpts,
} from "@/lib/cli/paging";
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

		if (jobType === "DESTROY_RUNNER") {
			// Runner teardown has no project config to snapshot — the client sends the
			// runner descriptor as the snapshot. This path scopes the job by
			// `user_id: userId` (org_id backfills to userId, the caller's personal org),
			// so the assigned runner must belong to that same org — the org
			// claim_next_job will compare `j.org_id` against. Fail closed (404) on a
			// cross-org / non-existent runner so we never queue an unclaimable job.
			if (assigned_runner_id) {
				try {
					await assertRunnerInOrg(db, assigned_runner_id, userId);
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

			await assertJobQuotaAllowed(userId);

			const [job] = await db
				.insert(jobs)
				.values(signedJob({
					user_id: userId,
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
		// caller's actor. The actions authorize via the PDP, freeze the nested
		// buildConfigSnapshot, insert the job, flip the env status, audit, and notify
		// the scaler — identical to a console-queued job.
		// A SERVICE TOKEN'S ORG WINS OVER THE HEADER, and over the caller's default scope.
		//
		// This route is PLAN / DEPLOY / DESTROY — it provisions and tears down real cloud
		// infrastructure — and it resolves its own scope rather than going through `authorizeCli`.
		// Without this, a token minted for one org could drive a deploy in another whenever its
		// creator belonged to both: not a cross-tenant escalation, but a containment promise the
		// product makes and would not have kept.
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

/** The collection name a `/api/jobs` cursor is bound to. See {@link CursorScope}. */
const JOBS_LIST = "jobs";

/** `?mine=` spellings that mean yes. A bare `?mine` arrives as the empty string. */
const MINE_TRUE = new Set(["", "true", "1"]);
/** `?mine=` spellings that mean no. Anything outside either set is a 400, never a silent no. */
const MINE_FALSE = new Set(["false", "0"]);

/**
 * Parses `?mine=`.
 *
 * NEITHER SET HAS A FALL-THROUGH. `?mine=yes` is a caller who believes they asked for their own
 * jobs; answering it with the whole org's is a wrong answer that looks like a right one, and the
 * flag exists precisely to make that distinction visible. So an unrecognised spelling is refused
 * rather than coerced, and the empty string — what `?mine` with no value produces — is the bare
 * flag, which is what a shell user types.
 */
function parseMine(raw: string | null): { ok: true; mine: boolean } | { ok: false } {
	if (raw === null) return { ok: true, mine: false };
	const v = raw.trim().toLowerCase();
	if (MINE_TRUE.has(v)) return { ok: true, mine: true };
	if (MINE_FALSE.has(v)) return { ok: true, mine: false };
	return { ok: false };
}

/** Parses the legacy `?offset=`: a non-negative integer, or absent. */
function parseOffset(raw: string | null): { ok: true; offset: number } | { ok: false } {
	if (raw === null || raw === "") return { ok: true, offset: 0 };
	if (!/^\d+$/.test(raw)) return { ok: false };
	const n = Number(raw);
	return Number.isSafeInteger(n) ? { ok: true, offset: n } : { ok: false };
}

function badRequest(error: string): NextResponse {
	return NextResponse.json({ error }, { status: 400 });
}

/**
 * Lists the caller's ORGANIZATION's jobs, cursor-paged, with the project and runner names joined.
 *
 * THE SCOPE WAS THE USER AND IS NOW THE ORG, AND THAT IS THE FIX (#3672). This route used to
 * filter on `jobs.user_id = <caller>`, so `alethia jobs list` and the console's jobs page —
 * `getJobsPage`, which reads through RLS at `org_id` — answered the same question differently:
 * a teammate's deploy of the org's own project was invisible from the terminal and plainly
 * listed in the browser. One product, two surfaces, two answers. The org is the tenancy scope
 * everywhere else in the schema, so the org is what this lists. `jobs.org_id` is stamped on
 * insert by `jobs_set_org_id` (programmables.sql), which derives it from the parent project and
 * falls back to the session org and then to `user_id` — `user_id` is NOT NULL, so the trigger has
 * no path that leaves the column unset. The column is nonetheless declared nullable and holds
 * pre-trigger history, which the migrations backfill rather than the schema forbid; that is why
 * this is a WHERE clause on org_id and not an assumption that every row has one.
 *
 * `?mine=true` is what makes the OLD behaviour addressable instead of implicit. It narrows to the
 * caller's own jobs, and — being a scope predicate rather than a post-filter — it narrows `total`
 * and `page.total` with the rows. A count taken from a different set of predicates than the rows
 * is the defect the console's filter standard exists to prevent.
 *
 * `X-Alethia-Org` NOW APPLIES HERE. The GET resolved the caller's default scope and consulted no
 * policy at all; it goes through `authorizeCli` like every sibling CLI job route, so the header
 * (the `--org` flag), the service-token org pin that refuses a conflicting header, and the
 * `view job` decision all reach this list. That is strictly more checking than before, not less.
 *
 * PAGING: CURSOR, WITH `?offset=` STILL HONOURED. `page` is the shared vocabulary
 * (`lib/cli/paging.ts`) and `?cursor=` is the mechanism the CLI's paginated table is being built
 * onto (#3667). Until that lands, `apps/cli/cmd/jobs_table.go:40` still walks this endpoint by
 * offset, and an offset the server quietly ignored would page the same rows forever — so the
 * legacy parameter keeps working and is simply one more clause on the same query. The two cannot
 * be combined: "skip 20 rows after this position" is a question no caller means to ask, and
 * answering it would hide whichever of the two the caller thought was in effect.
 *
 * TWO NUMBERS MOVED WITH THE CONVERSION, both widening and both echoed back in `page.limit`:
 * `?limit=` now defaults to 50 rather than 20 and clamps at 200 rather than 100, because those
 * are the vocabulary's shared bounds and a second set here would be a second contract. Every
 * shipped caller sends an explicit limit, so the default is reachable only by a hand-written
 * request. What a caller must NOT do is compute a page count from `total` without reading
 * `page.mode`: an exact `count(*)` per page was the full scan the cap exists to remove, so past
 * DEFAULT_COUNT_CAP rows `total` is a floor and an offset pager built on it stops at the cap.
 */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "job" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	const { searchParams } = new URL(req.url);

	const mine = parseMine(searchParams.get("mine"));
	if (!mine.ok) return badRequest("mine must be true or false");

	const legacyOffset = parseOffset(searchParams.get("offset"));
	if (!legacyOffset.ok) return badRequest("offset must be a non-negative integer");

	const cursorScope: CursorScope = { orgId: actor.orgId, list: JOBS_LIST };
	const parsed = parsePageOpts(searchParams, cursorScope);
	if (!parsed.ok) return badRequest(parsed.error);
	const opts = parsed.opts;

	if (opts.after !== null && legacyOffset.offset > 0) {
		return badRequest("cursor and offset cannot be combined; use cursor");
	}

	const status = searchParams.get("status");
	const db = getServiceDb();

	// THE TENANCY BOUNDARY. These routes read through getServiceDb(), whose role bypasses RLS, so
	// this predicate is the whole of it — and it is also what a cursor is fingerprinted against, so
	// a cursor minted in another org is refused above rather than answered here.
	const scope: [SQL, ...(SQL | undefined)[]] = [
		eq(jobs.org_id, actor.orgId),
		mine.mine ? eq(jobs.user_id, actor.userId) : undefined,
		status ? sql`${jobs.status}::text = ${status}` : undefined,
	];

	const { items, page } = await paginate({
		db,
		table: jobs,
		createdAt: jobs.created_at,
		id: jobs.id,
		scope,
		cursor: cursorScope,
		opts,
		rows: (query) =>
			db
				.select({
					job: jobs,
					// The ordering key as Postgres renders it — six fractional digits. Reading
					// `jobs.created_at` here would hand back a millisecond-precision JS Date and the
					// cursor built from it would silently skip every row in the truncated gap.
					cursor_key: cursorKey(jobs.created_at),
					project_name: projects.project_name,
					runner_name: runners.name,
				})
				.from(jobs)
				.leftJoin(projects, eq(jobs.project_id, projects.id))
				.leftJoin(runners, eq(jobs.runner_id, runners.id))
				.where(query.where)
				.orderBy(...query.orderBy)
				.limit(query.limit)
				.offset(legacyOffset.offset),
		positionOf: (r) => ({ createdAt: r.cursor_key, id: r.job.id }),
	});

	const result = items.map((r) => ({
		...r.job,
		project_name: r.project_name ?? null,
		runner_name: r.runner_name ?? null,
	}));

	// `total`/`limit`/`offset` are the pre-cursor wire, kept so the shipped CLI's offset pager
	// keeps working. `total` IS `page.total` and `limit` IS `page.limit` — echoed, never counted
	// or clamped a second time, because two fields that must agree are two fields that can
	// disagree.
	return cliJson(cliJobsPageResponse, {
		jobs: result,
		total: page.total,
		limit: page.limit,
		offset: legacyOffset.offset,
		page,
	});
}
