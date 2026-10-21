"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal } from "@/lib/actions/result";
import { authorize } from "@/lib/authz/guard";
import { UsageLimitError } from "@/lib/billing/usage-guard";
import { signedJob } from "@/lib/db/signed-job";
import { assertRunnerInOrg } from "@/lib/authz/runner-org";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { getServiceDb, withActorScope, type Tx } from "@/lib/db";
import { cloudIdentities, jobs, runnerReleases, runners } from "@/lib/db/schema";
import { defaultInOrg, readOwnRunnerViews, type RunnerView } from "@/lib/rpc/procedures/runners";
import { generateRunnerToken } from "@/lib/runners/auth";
import { unheldRunnerTokenHash } from "@/lib/runners/lifecycle-token";
import {
	isRunnerDeployProvider,
	runnerDeployUnsupportedMessage,
} from "@/lib/runners/deploy-providers";
import { notifyScaler } from "@/lib/scaler";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";

/**
 * The org's own runners (no managed fleet), as the browser-safe view the read router serves — for
 * the mention picker and the agent's runner tool. The runners PAGE reads `runners.list` /
 * `runners.page` (lib/rpc/procedures/runners.ts), where this body now lives.
 */
export async function getRunnersWithReleases(): Promise<RunnerView[]> {
	return readOwnRunnerViews();
}

/** Count of runners currently ONLINE and visible to the user. */
export async function getOnlineRunnerCount(): Promise<number> {
	const actor = await authorize("view", { type: "runner" });
	return withActorScope(actor, async (tx) => {
		const [row] = await tx
			.select({ value: count() })
			.from(runners)
			.where(eq(runners.status, "ONLINE"));
		return row?.value ?? 0;
	});
}

/**
 * Registers a self-operated runner the user brings themselves (own Terraform or
 * `alethia runner start`), returning the one-time token. Always
 * operator=self, provisioning=registered.
 */
export async function registerRunner(name: string) {
	const actor = await authorize("create", { type: "runner" });
	const owner = actor.userId;
	const { token: runnerToken, hash: tokenHash } = generateRunnerToken();

	const runner = await withActorScope(actor, async (tx) => {
		const [r] = await tx
			.insert(runners)
			.values({
				user_id: owner,
				name,
				operator: "self",
				provisioning: "registered",
				token_hash: tokenHash,
			})
			.returning({
				id: runners.id,
				name: runners.name,
				operator: runners.operator,
				provisioning: runners.provisioning,
				status: runners.status,
				created_at: runners.created_at,
			});
		return r;
	});

	return { runner, runner_token: runnerToken };
}

/** Sets (or clears) the current user's default runner within the addressed org (or personal workspace). */
export async function setDefaultRunner(runnerId: string | null) {
	const actor = await authorize("edit", {
		type: "runner",
		id: runnerId ?? undefined,
	});
	const owner = actor.userId;
	await getServiceDb().execute(
		sql`select set_default_runner(${owner}::uuid, ${actor.orgId}::uuid, ${runnerId ?? null}::uuid)`,
	);
}

/** Returns all runners visible to the current user, default first. */
export async function getAvailableRunners() {
	const actor = await authorize("view", { type: "runner" });
	return withActorScope(actor, async (tx) =>
		tx
			.select({
				id: runners.id,
				name: runners.name,
				operator: runners.operator,
				provisioning: runners.provisioning,
				status: runners.status,
				is_default: defaultInOrg(actor.orgId),
			})
			.from(runners)
			.orderBy(desc(defaultInOrg(actor.orgId)), asc(runners.name)),
	);
}

/**
 * Deploys a runner into the user's cloud account through an existing runner that
 * runs Terraform. The new runner is operator=self, provisioning=deployed.
 */
export async function deployRunner(params: {
	name: string;
	cloudIdentityId: string;
	region: string;
	imageTag?: string;
	assignedRunnerId?: string | null;
}) {
	const actor = await authorize("deploy", { type: "runner" });
	// Defense-in-depth: the existing runner that will run this deploy must belong
	// to the caller's org (claim_next_job blocks execution; this blocks enqueue).
	if (params.assignedRunnerId)
		await assertRunnerInOrg(getServiceDb(), params.assignedRunnerId, actor.orgId, actor.userId);
	const owner = actor.userId;

	await assertJobQuotaAllowed(actor.orgId);

	const result = await withActorScope(actor, async (tx) => {
		// Resolve + gate the identity BEFORE anything is written: a deploy we cannot build must
		// not leave an orphan runners row behind, and a MISSING identity is an error rather than
		// an implicit AWS deploy (the old `?? "aws"` coerced it into one).
		const [identity] = await tx
			.select({ provider: cloudIdentities.provider })
			.from(cloudIdentities)
			.where(eq(cloudIdentities.id, params.cloudIdentityId))
			.limit(1);

		if (!identity) throw new ActionRefusal("not-found", "Cloud identity not found");
		if (!isRunnerDeployProvider(identity.provider))
			throw new ActionRefusal("conflict", runnerDeployUnsupportedMessage(identity.provider));

		const [runner] = await tx
			.insert(runners)
			.values({
				user_id: owner,
				org_id: actor.orgId,
				name: params.name,
				operator: "self",
				provisioning: "deployed",
				// No usable credential until the DEPLOY_RUNNER job is claimed: the claim mints the token
				// and hands it to the executing runner alone (lib/runners/lifecycle-token.ts).
				token_hash: unheldRunnerTokenHash(),
				cloud_identity_id: params.cloudIdentityId,
			})
			.returning({ id: runners.id, name: runners.name });

		const configSnapshot = {
			runner_id: runner.id,
			runner_name: params.name,
			image_tag: params.imageTag || "latest",
			region: params.region,
			cloud_provider: identity.provider,
			alethia_url:
				process.env.NEXT_PUBLIC_APP_URL || "https://alethialabs.io",
		};

		const [job] = await tx
			.insert(jobs)
			.values(signedJob({
				user_id: owner,
				// Keep lifecycle state, quota, evidence, and visibility in the active tenant.
				org_id: actor.orgId,
				cloud_identity_id: params.cloudIdentityId,
				job_type: "DEPLOY_RUNNER",
				initiated_by: "user",
				config_snapshot: configSnapshot,
				status: "QUEUED",
				assigned_runner_id: params.assignedRunnerId ?? null,
			}))
			.returning({ id: jobs.id });

		return { runnerId: runner.id, jobId: job.id };
	});

	notifyScaler();
	return result;
}

/** Fetches a deployed runner, verifies ownership, and resolves cloud provider. */
async function fetchDeployedRunner(
	actor: { userId: string; orgId: string },
	runnerId: string,
) {
	return withActorScope(actor, async (tx) => {
		const [runner] = await tx
			.select({
				id: runners.id,
				name: runners.name,
				cloud_identity_id: runners.cloud_identity_id,
				metadata: runners.metadata,
			})
			.from(runners)
			.where(eq(runners.id, runnerId))
			.limit(1);

		// Ownership: enforced by the caller's authorize() + the withActorScope RLS
		// (a runner outside the actor's org is simply not returned above).
		if (!runner) throw new ActionRefusal("not-found", "Runner not found");
		if (!runner.cloud_identity_id)
			throw new ActionRefusal("conflict", "Runner has no cloud identity");

		const deployConfig = runner.metadata?.deploy_config;
		if (!deployConfig)
			throw new ActionRefusal(
				"conflict",
				"Runner has no deploy config — it may not have been deployed successfully",
			);

		const [identity] = await tx
			.select({ provider: cloudIdentities.provider })
			.from(cloudIdentities)
			.where(eq(cloudIdentities.id, runner.cloud_identity_id))
			.limit(1);

		return { runner, deployConfig, identity: identity ?? null };
	});
}

/**
 * Builds a runner config snapshot from deploy_config with optional overrides.
 *
 * This is the DAY-2 path (UPDATE_RUNNER / DESTROY_RUNNER on a runner that already exists), not
 * the enqueue path #1794 is about — the cloud is not being chosen here, it is being RECALLED. So
 * it deliberately does NOT gate on `isRunnerDeployProvider`: a runner deployed before that gate
 * existed must still be destroyable, and refusing here would wedge its row forever.
 *
 * What it must not do is GUESS. The provider used to fall back to a hard-coded `"aws"` when both
 * the identity row and `deploy_config.cloud_provider` were missing — a second hand-written
 * literal for a fact `lib/runners/deploy-providers.ts` now owns, and one that would hand the
 * runner an AWS destroy for a non-AWS runner (the identity row can be deleted after the deploy).
 * Two recorded sources, then a hard error: the caller sees "which cloud?" instead of tofu
 * destroying against the wrong one.
 */
function buildRunnerConfigSnapshot(
	runner: { id: string; name: string },
	deployConfig: NonNullable<
		Awaited<ReturnType<typeof fetchDeployedRunner>>["deployConfig"]
	>,
	provider: string | null | undefined,
	overrides?: { image_tag?: string },
) {
	const cloudProvider = provider ?? deployConfig.cloud_provider;
	if (!cloudProvider)
		throw new ActionRefusal(
			"conflict",
			`Runner ${runner.name} has no recorded cloud provider — its cloud identity is gone and deploy_config.cloud_provider is unset, so there is nothing safe to target.`,
		);

	return {
		runner_id: runner.id,
		runner_name: runner.name,
		region: deployConfig.region,
		cloud_provider: cloudProvider,
		image_tag: overrides?.image_tag ?? deployConfig.image_tag ?? "latest",
		alethia_url:
			deployConfig.alethia_url ??
			process.env.NEXT_PUBLIC_APP_URL ??
			"https://alethialabs.io",
		cpu: deployConfig.cpu ?? 512,
		memory: deployConfig.memory ?? 1024,
		image_repository:
			deployConfig.image_repository ?? "ghcr.io/alethialabs-io/runner",
	};
}

/**
 * Rejects a new runner-lifecycle job when ANY DEPLOY/UPDATE/DESTROY_RUNNER job for this runner is
 * already active. All three share one tofu-state object (`runners/{id}/tofu.tfstate`), so overlapping
 * ops would race the state lock and — worse — a DESTROY could delete the runner + purge its state
 * under a live UPDATE. The console tofu-lock serializes concurrent writes, but not this higher-level
 * ordering, so guard it at queue time.
 */
async function assertNoActiveLifecycleJob(
	tx: Tx,
	runnerId: string,
): Promise<void> {
	const active = await tx
		.select({ config_snapshot: jobs.config_snapshot })
		.from(jobs)
		.where(
			and(
				inArray(jobs.job_type, [
					"DEPLOY_RUNNER",
					"UPDATE_RUNNER",
					"DESTROY_RUNNER",
				]),
				inArray(jobs.status, ["QUEUED", "CLAIMED", "PROCESSING"]),
			),
		);
	if (active.some((j) => j.config_snapshot?.runner_id === runnerId)) {
		throw new ActionRefusal(
			"conflict",
			"A runner-lifecycle job is already in progress for this runner",
		);
	}
}

/** Queues a DESTROY_RUNNER job for a self-operated, deployed runner with cloud resources. */
export async function destroyRunner(
	runnerId: string,
	assignedRunnerId?: string | null,
) {
	const actor = await authorize("destroy", { type: "runner", id: runnerId });
	// Defense-in-depth: the existing runner that will run this destroy must belong
	// to the caller's org (claim_next_job blocks execution; this blocks enqueue).
	if (assignedRunnerId)
		await assertRunnerInOrg(getServiceDb(), assignedRunnerId, actor.orgId, actor.userId);
	const owner = actor.userId;
	const { runner, deployConfig, identity } = await fetchDeployedRunner(
		actor,
		runnerId,
	);

	await assertJobQuotaAllowed(actor.orgId);

	const result = await withActorScope(actor, async (tx) => {
		await assertNoActiveLifecycleJob(tx, runnerId);

		// DESTROY needs no runner token: the runner's destroy path uses a placeholder tfvar and never
		// authenticates as the target, so none is issued at claim either.
		const configSnapshot = buildRunnerConfigSnapshot(
			runner,
			deployConfig,
			identity?.provider,
		);

		const [job] = await tx
			.insert(jobs)
			.values(signedJob({
				user_id: owner,
				// Keep lifecycle state, quota, evidence, and visibility in the active tenant.
				org_id: actor.orgId,
				cloud_identity_id: runner.cloud_identity_id!,
				job_type: "DESTROY_RUNNER",
				initiated_by: "user",
				config_snapshot: configSnapshot,
				status: "QUEUED",
				assigned_runner_id: assignedRunnerId ?? null,
			}))
			.returning({ id: jobs.id });

		return { jobId: job.id };
	});

	notifyScaler();
	return result;
}

/** Queues an UPDATE_RUNNER job to roll a deployed runner to the latest release. */
export async function updateRunner(runnerId: string) {
	const actor = await authorize("edit", { type: "runner", id: runnerId });
	const owner = actor.userId;
	const { runner, deployConfig, identity } = await fetchDeployedRunner(
		actor,
		runnerId,
	);

	await assertJobQuotaAllowed(actor.orgId);

	// UPDATE re-deploys the runner container with a FRESH token. The previous credential is retired
	// here, at enqueue, and the new one is minted when the job is claimed and handed to the executing
	// runner alone (lib/runners/lifecycle-token.ts) — so the job row never carries it.

	const result = await withActorScope(actor, async (tx) => {
		await assertNoActiveLifecycleJob(tx, runnerId);

		const [latestRelease] = await tx
			.select({ version: runnerReleases.version })
			.from(runnerReleases)
			.orderBy(desc(runnerReleases.released_at))
			.limit(1);

		if (!latestRelease) throw new ActionRefusal("conflict", "No runner releases found");

		await tx
			.update(runners)
			.set({ token_hash: unheldRunnerTokenHash() })
			.where(eq(runners.id, runnerId));

		const configSnapshot = buildRunnerConfigSnapshot(
			runner,
			deployConfig,
			identity?.provider,
			{ image_tag: latestRelease.version },
		);

		const [job] = await tx
			.insert(jobs)
			.values(signedJob({
				user_id: owner,
				// Keep lifecycle state, quota, evidence, and visibility in the active tenant.
				org_id: actor.orgId,
				cloud_identity_id: runner.cloud_identity_id!,
				job_type: "UPDATE_RUNNER",
				initiated_by: "user",
				config_snapshot: configSnapshot,
				status: "QUEUED",
			}))
			.returning({ id: jobs.id });

		return { jobId: job.id };
	});

	notifyScaler();
	return result;
}

/** Deletes a runner record directly (no cloud resources to tear down). */
export async function removeRunner(runnerId: string) {
	const actor = await authorize("destroy", { type: "runner", id: runnerId });
	await withActorScope(actor, async (tx) => {
		const [runner] = await tx
			.select({ id: runners.id })
			.from(runners)
			.where(eq(runners.id, runnerId))
			.limit(1);

		// Ownership enforced by authorize() above + withActorScope RLS.
		if (!runner) throw new ActionRefusal("not-found", "Runner not found");

		await tx.delete(runners).where(eq(runners.id, runnerId));
	});
}

// ── The console's mutation contract (ADR 0005 D4, #6123) ────────────────────────────────────────
//
// The runners page calls these, through `useActionMutation`, never the functions above directly:
// each parses its input, runs the SAME function the API routes call (so every authorize/quota/
// ownership check above is the one that runs), and answers an `ActionResult` whose refusals the page
// renders by kind. The functions above stay exported for their in-process callers (the CLI and jobs
// API routes, the tests); their own throws are unchanged except that a refusal the user caused is an
// `ActionRefusal` (same message), so it is shown rather than reported as an unexpected failure.

const runnerIdSchema = z.string().uuid();
const runnerNameSchema = z.string().trim().min(1, "Runner name is required").max(60);

/** A plan's job cap is a refusal the user can act on (upgrade, or wait), not an unexpected failure. */
async function refusingUsageLimit<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof UsageLimitError) {
			throw new ActionRefusal(error.upgradable ? "entitlement" : "conflict", error.message);
		}
		throw error;
	}
}

// Each action below is a plain async function whose body builds its contract inline, so the
// action-boundary guard (scripts/check-action-boundary.mjs) follows it to the function it runs and
// from there to that function's `authorize` — a `defineAction(...)` value exported directly is not a
// function that guard can follow.

const setDefaultInput = z.object({ runnerId: runnerIdSchema.nullable() });

/** Sets (or clears, with `runnerId: null`) the caller's default runner in the addressed org. */
export async function setDefaultRunnerAction(raw: z.input<typeof setDefaultInput>) {
	return defineAction({
		input: setDefaultInput,
		run: async ({ input }) => {
			await setDefaultRunner(input.runnerId);
			return { runnerId: input.runnerId };
		},
	})(raw);
}

const registerInput = z.object({ name: runnerNameSchema });

/** Registers a self-operated runner; answers the one-time token the dialog shows once. */
export async function registerRunnerAction(raw: z.input<typeof registerInput>) {
	return defineAction({ input: registerInput, run: ({ input }) => registerRunner(input.name) })(raw);
}

const deployInput = z.object({
	name: runnerNameSchema,
	cloudIdentityId: z.string().uuid("Cloud account is required"),
	region: z.string().min(1, "Region is required").max(100),
	imageTag: z.string().max(200).optional(),
	assignedRunnerId: runnerIdSchema.nullable().optional(),
});

/** Deploys a runner into a cloud account through an existing runner. */
export async function deployRunnerAction(raw: z.input<typeof deployInput>) {
	return defineAction({
		input: deployInput,
		run: ({ input }) => refusingUsageLimit(() => deployRunner(input)),
	})(raw);
}

const runnerInput = z.object({ runnerId: runnerIdSchema });

/** Queues an UPDATE_RUNNER job that rolls a deployed runner to the latest release. */
export async function updateRunnerAction(raw: z.input<typeof runnerInput>) {
	return defineAction({
		input: runnerInput,
		run: ({ input }) => refusingUsageLimit(() => updateRunner(input.runnerId)),
	})(raw);
}

const destroyInput = z.object({ runnerId: runnerIdSchema, assignedRunnerId: runnerIdSchema.nullable().optional() });

/** Queues a DESTROY_RUNNER job (optionally on a chosen runner). */
export async function destroyRunnerAction(raw: z.input<typeof destroyInput>) {
	return defineAction({
		input: destroyInput,
		run: ({ input }) => refusingUsageLimit(() => destroyRunner(input.runnerId, input.assignedRunnerId)),
	})(raw);
}

/** Removes a runner record that has no cloud resources to tear down. */
export async function removeRunnerAction(raw: z.input<typeof runnerInput>) {
	return defineAction({
		input: runnerInput,
		run: async ({ input }) => {
			await removeRunner(input.runnerId);
			return { runnerId: input.runnerId };
		},
	})(raw);
}
