// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli } from "@/lib/authz/guard";
import { signedJob } from "@/lib/db/signed-job";
import {
	assertRunnerInOrg,
	resolveUnassignedRunnerJobOrg,
} from "@/lib/authz/runner-org";
import { ForbiddenError } from "@/lib/authz/types";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities, jobs, runnerReleases, runners } from "@/lib/db/schema";
import {
	isRunnerDeployProvider,
	runnerDeployUnsupportedMessage,
} from "@/lib/runners/deploy-providers";
import { notifyScaler } from "@/lib/scaler";
import { createHash, randomBytes } from "crypto";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { deployRunnerWire } from "@/lib/validations/cli-contract";

/**
 * Deploys a runner by creating a runner record + queuing a DEPLOY_RUNNER job.
 *
 * TENANCY (#3874). Both inserts run on `getServiceDb()` — a role that bypasses RLS and
 * sets no `app.current_org` GUC — so the `set_org_id` / `set_org_id_from_project` triggers
 * fell through to their last branch and stamped `org_id = NEW.user_id`: a member of a Teams
 * org got a runner and a job in their PERSONAL org. They matched each other, which is why
 * the pair worked; they were both wrong in the same direction. Both are now stamped
 * EXPLICITLY rather than by a trigger fallback — the runners row with `actor.orgId`, the org
 * already used for the identity check and the quota, and the job with the org resolved just
 * below — so `claim_next_job`'s `j.org_id = v_runner_org_id` equality holds against the runner
 * that will actually claim it, rather than by coincidence.
 *
 * `assigned_runner_id` (the EXISTING runner that executes the deploy) is deliberately
 * validated WITHOUT the transitional personal-org admission #3874 added to
 * `assertRunnerInOrg`: on that path this job is stamped `actor.orgId`, so admitting a
 * personal-org runner here would queue a job whose org can never equal its executor's —
 * QUEUED forever. The strict guard refuses it up front instead, which is also the pre-#3874
 * behaviour.
 *
 * WITH NO EXECUTOR NAMED THE JOB'S ORG IS RESOLVED FROM THE FLEET (#4022). `actor.orgId` is
 * right only while a self runner of that org exists to claim it: `claim_next_job` Phase B's
 * `ELSE` arm repeats Phase A's `j.org_id = v_runner_org_id` verbatim, and only its MANAGED arm
 * ignores org. A Teams member whose runners are all pre-#3874 therefore got a DEPLOY_RUNNER
 * nothing could claim — the same QUEUED-forever failure #4022 reported against DESTROY_RUNNER,
 * on the path `assertRunnerInOrg`'s own JSDoc pairs with it. See
 * {@link resolveUnassignedRunnerJobOrg}; the resolution runs BEFORE the runners insert below,
 * because the row this request is about to create must not vote in its own fleet scan.
 *
 * THE TWO STAMPS THEN DIVERGE IN EXACTLY ONE CASE, AND THAT IS SOUND. The runners row keeps
 * `actor.orgId` — the forward-correct tenancy for a runner being created now — while the job
 * may take the personal org. Nothing requires them to match: `claim_next_job` compares the job
 * against the org of the runner that CLAIMS it, and the row being created here cannot claim its
 * own deploy job. It does not exist yet.
 */
export async function POST(req: Request) {
	const auth = await authorizeCli(req, "deploy", { type: "runner" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const body = await req.json();
		const { name, cloud_identity_id, region, assigned_runner_id } = body;

		if (!name || !cloud_identity_id || !region) {
			return NextResponse.json(
				{ error: "name, cloud_identity_id, and region are required" },
				{ status: 400 },
			);
		}

		const db = getServiceDb();

		// Defense-in-depth: the existing runner that will run this deploy must belong
		// to the caller's org (matches the identity org-check below and the org
		// claim_next_job compares against). Fail closed (404) — same shape as a
		// missing runner — so we never disclose a runner in another org.
		if (assigned_runner_id) {
			try {
				await assertRunnerInOrg(db, assigned_runner_id, actor.orgId);
			} catch (e: unknown) {
				if (e instanceof ForbiddenError) {
					return NextResponse.json(
						{ error: "Runner not found" },
						{ status: 404 },
					);
				}
				throw e;
			}
		}

		const [identity] = await db
			.select({
				id: cloudIdentities.id,
				provider: cloudIdentities.provider,
				org_id: cloudIdentities.org_id,
			})
			.from(cloudIdentities)
			.where(eq(cloudIdentities.id, cloud_identity_id))
			.limit(1);

		if (!identity) {
			return NextResponse.json(
				{ error: "Cloud identity not found" },
				{ status: 404 },
			);
		}

		if (identity.org_id !== actor.orgId) {
			return NextResponse.json(
				{ error: "Unauthorized: cloud identity belongs to another org" },
				{ status: 403 },
			);
		}

		// This route re-implements the enqueue rather than calling deployRunner(), so it needs
		// the template gate of its own — a fix only in the server action leaves the CLI able to
		// queue a job that dies in the runner with "no templates for provider <cloud>".
		if (!isRunnerDeployProvider(identity.provider)) {
			return NextResponse.json(
				{ error: runnerDeployUnsupportedMessage(identity.provider) },
				{ status: 400 },
			);
		}

		// EVERY reason to refuse now runs before the FIRST insert, so a rejected deploy leaves
		// nothing behind. The quota assert used to sit between the runners insert and the jobs
		// insert, which orphaned a `provisioning=deployed` runner row — holding a live
		// token_hash — with no job to build it. deployRunner() (app/server/actions/runners.ts)
		// has always ordered it this way; this route is the copy that had drifted.
		//
		// The org this job will be STAMPED with, resolved before anything is written (#4022).
		// An executor was named ⇒ it was validated strictly against `actor.orgId` above, so that
		// is the org whose equality must hold. None named ⇒ ask the fleet that would have to
		// claim it. Ordering matters twice: the scan must not see the runners row this request
		// is about to insert, and the quota must be counted against the org the row lands in —
		// checking one org and inserting into another measures a tenant this enqueue never joins.
		const jobOrgId = assigned_runner_id
			? actor.orgId
			: await resolveUnassignedRunnerJobOrg(db, actor.orgId, actor.userId);

		await assertJobQuotaAllowed(jobOrgId);

		const [latestRelease] = await db
			.select({ version: runnerReleases.version })
			.from(runnerReleases)
			.orderBy(desc(runnerReleases.released_at))
			.limit(1);

		const imageTag = latestRelease?.version ?? "latest";

		const runnerToken = randomBytes(32).toString("hex");
		const tokenHash = createHash("sha256").update(runnerToken).digest("hex");

		const [runner] = await db
			.insert(runners)
			.values({
				user_id: actor.userId,
				// Explicit (#3874) — without it the set_org_id trigger stamps user_id here,
				// because this insert carries no app.current_org GUC.
				org_id: actor.orgId,
				name,
				operator: "self",
				provisioning: "deployed",
				token_hash: tokenHash,
				cloud_identity_id,
			})
			.returning({ id: runners.id, name: runners.name });

		const configSnapshot = {
			runner_id: runner.id,
			runner_token: runnerToken,
			runner_name: name,
			image_tag: imageTag,
			region,
			cloud_provider: identity.provider,
			alethia_url:
				process.env.NEXT_PUBLIC_APP_URL || "https://alethialabs.io",
		};

		const [job] = await db
			.insert(jobs)
			.values(signedJob({
				user_id: actor.userId,
				// #3874 stamps this explicitly rather than letting the trigger's `NEW.user_id`
				// fallback choose the tenancy. #4022 decides WHICH org: the runners row above is
				// the runner being created and keeps `actor.orgId`; this row is the job some
				// EXISTING runner has to claim, so on the unassigned path it takes the org that
				// fleet can actually match. The two agree in every case but that one.
				org_id: jobOrgId,
				cloud_identity_id,
				job_type: "DEPLOY_RUNNER",
				initiated_by: "user",
				config_snapshot: configSnapshot,
				status: "QUEUED",
				assigned_runner_id: assigned_runner_id || null,
			}))
			.returning({
				id: jobs.id,
				status: jobs.status,
				created_at: jobs.created_at,
			});

		notifyScaler();
		return cliJson(deployRunnerWire, { runner, job }, { status: 201 });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
