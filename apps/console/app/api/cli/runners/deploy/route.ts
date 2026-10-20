// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli, userIdIsTheCaller } from "@/lib/authz/guard";
import { signedJob } from "@/lib/db/signed-job";
import {
	assertRunnerInOrg,
	personalRunnerArm,
} from "@/lib/authz/runner-org";
import { ForbiddenError } from "@/lib/authz/types";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities, jobs, runnerReleases, runners } from "@/lib/db/schema";
import {
	isRunnerDeployProvider,
	runnerDeployUnsupportedMessage,
} from "@/lib/runners/deploy-providers";
import { actorIdentityWhere } from "@/lib/runners/claim-identity";
import { unheldRunnerTokenHash } from "@/lib/runners/lifecycle-token";
import { notifyScaler } from "@/lib/scaler";
import { desc } from "drizzle-orm";
import { z } from "zod";
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
 * already used for identity checks, quota, reporting, and lifecycle serialization.
 * Pre-#3874 caller-owned runners retain a narrow claim-time compatibility path for
 * lifecycle jobs; the job itself never leaves the active tenant.
 */
export async function POST(req: Request) {
	const auth = await authorizeCli(req, "deploy", { type: "runner" });
	if ("error" in auth) return auth.error;
	const { actor, credential } = auth;

	try {
		const body = await req.json();
		const { name, cloud_identity_id, region, assigned_runner_id } = body;

		if (!name || !cloud_identity_id || !region) {
			return NextResponse.json(
				{ error: "name, cloud_identity_id, and region are required" },
				{ status: 400 },
			);
		}

		const identityId = z.uuid().safeParse(cloud_identity_id);
		if (!identityId.success) {
			return NextResponse.json(
				{ error: "cloud_identity_id must be a cloud identity id (a UUID)" },
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
				// `personalRunnerArm` and not `actor.userId`: for a service token that id is the
				// MINTER, and admitting their personal runner would let a pinned token hand an
				// org job to an executor outside the pin (#4298).
				await assertRunnerInOrg(
					db,
					assigned_runner_id,
					actor.orgId,
					personalRunnerArm(actor, credential),
				);
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

		// The identity the DEPLOY_RUNNER job carries — and the claim route hands the runner — must be
		// one this caller may use: an `org` identity of this org, or a person's own `personal` one.
		// The same rule as the `/api/jobs` DESTROY_RUNNER branch. A service token's `userId` is its
		// minter, so it gets the org arm only. Another org's identity, another member's personal one
		// and an id that does not exist all answer the same 404.
		const [identity] = await db
			.select({
				id: cloudIdentities.id,
				provider: cloudIdentities.provider,
			})
			.from(cloudIdentities)
			.where(
				actorIdentityWhere(
					identityId.data,
					actor.orgId,
					userIdIsTheCaller(credential) ? actor.userId : undefined,
				),
			)
			.limit(1);

		if (!identity) {
			return NextResponse.json(
				{
					error: userIdIsTheCaller(credential)
						? "Cloud identity not found. Use one of the organization's cloud accounts, or one of your own."
						: "Cloud identity not found. A service token can use only the organization's shared cloud accounts.",
				},
				{ status: 404 },
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
		await assertJobQuotaAllowed(actor.orgId);

		const [latestRelease] = await db
			.select({ version: runnerReleases.version })
			.from(runnerReleases)
			.orderBy(desc(runnerReleases.released_at))
			.limit(1);

		const imageTag = latestRelease?.version ?? "latest";

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
				// No usable credential until the DEPLOY_RUNNER job is claimed: the claim mints the token
				// and hands it to the executing runner alone (lib/runners/lifecycle-token.ts).
				token_hash: unheldRunnerTokenHash(),
				cloud_identity_id: identityId.data,
			})
			.returning({ id: runners.id, name: runners.name });

		const configSnapshot = {
			runner_id: runner.id,
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
				// Explicitly retain the active tenant; claim-time compatibility handles legacy runners.
				org_id: actor.orgId,
				cloud_identity_id: identityId.data,
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
