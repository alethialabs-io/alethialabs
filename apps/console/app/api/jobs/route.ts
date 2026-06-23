// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "crypto";
import { type SQL, and, count, desc, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { verifyCliToken } from "@/lib/cli/auth";
import { cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import { jobs, runners, specEnvironments, specs } from "@/lib/db/schema";
import { querySpecFull } from "@/lib/queries/spec-full";
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

/** Queues a provisioning job for the CLI user, snapshotting the spec config. */
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
			zone_id,
			configuration_id,
			cloud_identity_id,
			config_snapshot,
			assigned_runner_id,
			plan_job_id,
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

		let snapshot: Record<string, unknown> = config_snapshot || {};
		let configHash: string | null = null;
		let resolvedCloudIdentityId: string | null = cloud_identity_id || null;
		let resolvedZoneId: string | null = zone_id || null;
		// M1: the CLI job targets the spec's default environment (status + identity).
		let resolvedEnvironmentId: string | null = null;

		if (
			(jobType === "DEPLOY" || jobType === "PLAN" || jobType === "DESTROY") &&
			configuration_id
		) {
			const [config] = await querySpecFull(db, {
				id: configuration_id,
				user_id: userId,
			});

			if (!config) {
				return NextResponse.json(
					{ error: "Configuration not found or unauthorized" },
					{ status: 404 },
				);
			}

			snapshot = config;
			configHash = createHash("sha256")
				.update(JSON.stringify(snapshot))
				.digest("hex");

			if (!resolvedCloudIdentityId && config.cloud_identity_id) {
				resolvedCloudIdentityId = config.cloud_identity_id;
			}
			if (!resolvedZoneId && config.zone_id) {
				resolvedZoneId = config.zone_id;
			}

			const [defEnv] = await db
				.select({ id: specEnvironments.id })
				.from(specEnvironments)
				.where(
					and(
						eq(specEnvironments.spec_id, configuration_id),
						eq(specEnvironments.is_default, true),
					),
				)
				.limit(1);
			resolvedEnvironmentId = defEnv?.id ?? null;
		}

		const [job] = await db
			.insert(jobs)
			.values({
				user_id: userId,
				zone_id: resolvedZoneId,
				environment_id: resolvedEnvironmentId,
				cloud_identity_id: resolvedCloudIdentityId,
				job_type: jobType,
				spec_id: configuration_id || null,
				config_snapshot: snapshot,
				configuration_hash: configHash,
				status: "QUEUED",
				assigned_runner_id: assigned_runner_id || null,
				plan_job_id: plan_job_id || null,
			})
			.returning();

		// M1: provisioning status lives on the targeted environment.
		if (
			(jobType === "DEPLOY" || jobType === "PLAN") &&
			resolvedEnvironmentId
		) {
			await db
				.update(specEnvironments)
				.set({ status: "QUEUED" })
				.where(eq(specEnvironments.id, resolvedEnvironmentId));
		}

		if (jobType === "DESTROY" && resolvedEnvironmentId) {
			await db
				.update(specEnvironments)
				.set({ status: "DESTROYING" })
				.where(eq(specEnvironments.id, resolvedEnvironmentId));
		}

		// Ops alert (free): a teardown was requested. org_id is trigger-populated on insert.
		if (jobType === "DESTROY" && job.org_id) {
			emitAlertEventSafe(job.org_id, "system.job.destroy_requested", {
				title: "Destroy requested",
				severity: "warning",
				job_id: job.id,
				job_type: "DESTROY",
				spec_id: configuration_id,
				zone_id: job.zone_id ?? undefined,
			});
		}

		notifyScaler();
		return cliJson(cliJobResponse, { job }, { status: 201 });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

/** Lists the CLI user's jobs with the spec project name + runner name attached. */
export async function GET(req: Request) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) return authError;

	const userId = payload?.sub;
	if (!userId) {
		return NextResponse.json({ error: "Invalid token payload" }, { status: 401 });
	}

	const { searchParams } = new URL(req.url);
	const status = searchParams.get("status");
	const zoneId = searchParams.get("zone_id");
	const limit = Math.min(parseInt(searchParams.get("limit") || "20", 10), 100);
	const offset = parseInt(searchParams.get("offset") || "0", 10);

	const db = getServiceDb();

	const conds: SQL[] = [eq(jobs.user_id, userId)];
	if (status) conds.push(sql`${jobs.status}::text = ${status}`);
	if (zoneId) conds.push(eq(jobs.zone_id, zoneId));
	const whereExpr = and(...conds);

	const rows = await db
		.select({
			job: jobs,
			project_name: specs.project_name,
			runner_name: runners.name,
		})
		.from(jobs)
		.leftJoin(specs, eq(jobs.spec_id, specs.id))
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
		spec_name: r.project_name ?? null,
		runner_name: r.runner_name ?? null,
	}));

	return cliJson(cliJobsPageResponse, { jobs: result, total, limit, offset });
}
