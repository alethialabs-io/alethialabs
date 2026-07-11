"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorize } from "@/lib/authz/guard";
import { deploymentMode } from "@/lib/billing/config";
import { getServiceDb, withOwnerScope, type Tx } from "@/lib/db";
import { cloudIdentities, jobs, runnerReleases, runners } from "@/lib/db/schema";
import { queryProvisionedHours } from "@/lib/queries/runner-usage";
import { generateRunnerToken } from "@/lib/runners/auth";
import { notifyScaler } from "@/lib/scaler";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";

const RELEASE_FIELDS = {
	version: runnerReleases.version,
	release_notes: runnerReleases.release_notes,
	released_at: runnerReleases.released_at,
	github_release_url: runnerReleases.github_release_url,
	commit_sha: runnerReleases.commit_sha,
	is_breaking: runnerReleases.is_breaking,
} as const;

type ReleaseInfo = {
	version: string;
	release_notes: string;
	released_at: string;
	github_release_url: string | null;
	commit_sha: string | null;
	is_breaking: boolean;
};

/** Normalizes a release row (Date → ISO string) for the client store. */
function toReleaseInfo(r: {
	version: string;
	release_notes: string;
	released_at: Date;
	github_release_url: string | null;
	commit_sha: string | null;
	is_breaking: boolean;
}): ReleaseInfo {
	return { ...r, released_at: r.released_at.toISOString() };
}

/** The user's own runners (self/BYO), joined with their pinned release, default first. Managed
 *  (platform-fleet) runners are excluded by RLS — they are read separately via
 *  {@link getManagedRunnersWithReleases} on self-managed deployments. */
export async function getRunnersWithReleases() {
	const actor = await authorize("view", { type: "runner" });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
		const rows = await tx
			.select({ runner: runners, release: RELEASE_FIELDS })
			.from(runners)
			.leftJoin(runnerReleases, eq(runners.release_id, runnerReleases.id))
			.orderBy(
				desc(runners.is_default),
				asc(runners.operator),
				asc(runners.created_at),
			);
		return rows.map((r) => ({
			...r.runner,
			runner_releases: r.release ? toReleaseInfo(r.release) : null,
		}));
	});
}

/**
 * The managed warm-fleet runners (operator='managed'), joined with their release. These have no
 * owner/org so RLS hides them from the tenant path; they are platform infrastructure. Returns
 * `[]` on the hosted SaaS (tenants must never see our fleet); on a self-managed deployment the
 * operator IS the customer, so we read them via the service path (RLS-bypassing) for the fleet
 * view. Shaped identically to {@link getRunnersWithReleases} so the store can merge them.
 */
export async function getManagedRunnersWithReleases() {
	await authorize("view", { type: "runner" });
	if (deploymentMode() === "hosted") return [];
	const rows = await getServiceDb()
		.select({ runner: runners, release: RELEASE_FIELDS })
		.from(runners)
		.leftJoin(runnerReleases, eq(runners.release_id, runnerReleases.id))
		.where(eq(runners.operator, "managed"))
		.orderBy(asc(runners.created_at));
	return rows.map((r) => ({
		...r.runner,
		runner_releases: r.release ? toReleaseInfo(r.release) : null,
	}));
}

/**
 * Provisioned hours per managed runner for the current calendar month (UTC),
 * keyed by runner id. Reads the platform billing ledger via the service path
 * (RLS-denied to the app role); still-open sessions are billed up to now.
 */
export async function getManagedRunnerUsage(): Promise<Record<string, number>> {
	await authorize("view", { type: "runner" });
	// Managed-runner billing is platform data — never surfaced to hosted tenants.
	if (deploymentMode() === "hosted") return {};
	const now = new Date();
	const from = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
	);
	const rows = await queryProvisionedHours(getServiceDb(), { from, to: now });
	return Object.fromEntries(
		rows.map((r) => [r.runner_id, r.provisioned_hours]),
	);
}

/** The most recent runner release, or null. */
export async function getLatestRunnerRelease(): Promise<ReleaseInfo | null> {
	const actor = await authorize("view", { type: "runner" });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
		const [r] = await tx
			.select(RELEASE_FIELDS)
			.from(runnerReleases)
			.orderBy(desc(runnerReleases.released_at))
			.limit(1);
		return r ? toReleaseInfo(r) : null;
	});
}

/** The most recent runner releases (newest first) for the Versions changelog. */
export async function getRecentRunnerReleases(
	limit = 10,
): Promise<ReleaseInfo[]> {
	const actor = await authorize("view", { type: "runner" });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
		const rows = await tx
			.select(RELEASE_FIELDS)
			.from(runnerReleases)
			.orderBy(desc(runnerReleases.released_at))
			.limit(limit);
		return rows.map(toReleaseInfo);
	});
}

/** A runner release by version, or null. */
export async function getReleaseNotes(
	version: string,
): Promise<ReleaseInfo | null> {
	const actor = await authorize("view", { type: "runner" });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
		const [r] = await tx
			.select(RELEASE_FIELDS)
			.from(runnerReleases)
			.where(eq(runnerReleases.version, version))
			.limit(1);
		return r ? toReleaseInfo(r) : null;
	});
}

/** Count of runners currently ONLINE and visible to the user. */
export async function getOnlineRunnerCount(): Promise<number> {
	const actor = await authorize("view", { type: "runner" });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) => {
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

	const runner = await withOwnerScope(owner, async (tx) => {
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

/** Sets (or clears) the default runner for the current user. */
export async function setDefaultRunner(runnerId: string | null) {
	const actor = await authorize("edit", {
		type: "runner",
		id: runnerId ?? undefined,
	});
	const owner = actor.userId;
	await getServiceDb().execute(
		sql`select set_default_runner(${owner}::uuid, ${runnerId ?? null}::uuid)`,
	);
}

/** Returns all runners visible to the current user, default first. */
export async function getAvailableRunners() {
	const actor = await authorize("view", { type: "runner" });
	const owner = actor.userId;
	return withOwnerScope(owner, async (tx) =>
		tx
			.select({
				id: runners.id,
				name: runners.name,
				operator: runners.operator,
				provisioning: runners.provisioning,
				status: runners.status,
				is_default: runners.is_default,
			})
			.from(runners)
			.orderBy(desc(runners.is_default), asc(runners.name)),
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
	const owner = actor.userId;
	const { token: runnerToken, hash: tokenHash } = generateRunnerToken();

	const result = await withOwnerScope(owner, async (tx) => {
		const [runner] = await tx
			.insert(runners)
			.values({
				user_id: owner,
				name: params.name,
				operator: "self",
				provisioning: "deployed",
				token_hash: tokenHash,
				cloud_identity_id: params.cloudIdentityId,
			})
			.returning({ id: runners.id, name: runners.name });

		const [identity] = await tx
			.select({ provider: cloudIdentities.provider })
			.from(cloudIdentities)
			.where(eq(cloudIdentities.id, params.cloudIdentityId))
			.limit(1);

		const configSnapshot = {
			runner_id: runner.id,
			runner_token: runnerToken,
			runner_name: params.name,
			image_tag: params.imageTag || "latest",
			region: params.region,
			cloud_provider: identity?.provider ?? "aws",
			alethia_url:
				process.env.NEXT_PUBLIC_APP_URL || "https://alethialabs.io",
		};

		const [job] = await tx
			.insert(jobs)
			.values({
				user_id: owner,
				cloud_identity_id: params.cloudIdentityId,
				job_type: "DEPLOY_RUNNER",
				config_snapshot: configSnapshot,
				status: "QUEUED",
				assigned_runner_id: params.assignedRunnerId ?? null,
			})
			.returning({ id: jobs.id });

		return { runnerId: runner.id, jobId: job.id };
	});

	notifyScaler();
	return result;
}

/** Fetches a deployed runner, verifies ownership, and resolves cloud provider. */
async function fetchDeployedRunner(owner: string, runnerId: string) {
	return withOwnerScope(owner, async (tx) => {
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

		// Ownership: enforced by the caller's authorize() + the withOwnerScope RLS
		// (a runner outside the actor's org is simply not returned above).
		if (!runner) throw new Error("Runner not found");
		if (!runner.cloud_identity_id)
			throw new Error("Runner has no cloud identity");

		const deployConfig = runner.metadata?.deploy_config;
		if (!deployConfig)
			throw new Error(
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

/** Builds a runner config snapshot from deploy_config with optional overrides. */
function buildRunnerConfigSnapshot(
	runner: { id: string; name: string },
	deployConfig: NonNullable<
		Awaited<ReturnType<typeof fetchDeployedRunner>>["deployConfig"]
	>,
	provider: string | null | undefined,
	overrides?: { runner_token?: string; image_tag?: string },
) {
	return {
		runner_id: runner.id,
		runner_token: overrides?.runner_token ?? "",
		runner_name: runner.name,
		region: deployConfig.region,
		cloud_provider: provider ?? deployConfig.cloud_provider ?? "aws",
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
		throw new Error(
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
	const owner = actor.userId;
	const { runner, deployConfig, identity } = await fetchDeployedRunner(
		owner,
		runnerId,
	);

	const result = await withOwnerScope(owner, async (tx) => {
		await assertNoActiveLifecycleJob(tx, runnerId);

		const configSnapshot = buildRunnerConfigSnapshot(
			runner,
			deployConfig,
			identity?.provider,
			{ runner_token: deployConfig.runner_token },
		);

		const [job] = await tx
			.insert(jobs)
			.values({
				user_id: owner,
				cloud_identity_id: runner.cloud_identity_id!,
				job_type: "DESTROY_RUNNER",
				config_snapshot: configSnapshot,
				status: "QUEUED",
				assigned_runner_id: assignedRunnerId ?? null,
			})
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
		owner,
		runnerId,
	);

	if (!deployConfig.runner_token)
		throw new Error(
			"Runner is missing deploy token — re-deploy required to enable updates",
		);

	const result = await withOwnerScope(owner, async (tx) => {
		await assertNoActiveLifecycleJob(tx, runnerId);

		const [latestRelease] = await tx
			.select({ version: runnerReleases.version })
			.from(runnerReleases)
			.orderBy(desc(runnerReleases.released_at))
			.limit(1);

		if (!latestRelease) throw new Error("No runner releases found");

		const configSnapshot = buildRunnerConfigSnapshot(
			runner,
			deployConfig,
			identity?.provider,
			{
				runner_token: deployConfig.runner_token,
				image_tag: latestRelease.version,
			},
		);

		const [job] = await tx
			.insert(jobs)
			.values({
				user_id: owner,
				cloud_identity_id: runner.cloud_identity_id!,
				job_type: "UPDATE_RUNNER",
				config_snapshot: configSnapshot,
				status: "QUEUED",
			})
			.returning({ id: jobs.id });

		return { jobId: job.id };
	});

	notifyScaler();
	return result;
}

/** Deletes a runner record directly (no cloud resources to tear down). */
export async function removeRunner(runnerId: string) {
	const actor = await authorize("destroy", { type: "runner", id: runnerId });
	const owner = actor.userId;
	await withOwnerScope(owner, async (tx) => {
		const [runner] = await tx
			.select({ id: runners.id })
			.from(runners)
			.where(eq(runners.id, runnerId))
			.limit(1);

		// Ownership enforced by authorize() above + withOwnerScope RLS.
		if (!runner) throw new Error("Runner not found");

		await tx.delete(runners).where(eq(runners.id, runnerId));
	});
}
