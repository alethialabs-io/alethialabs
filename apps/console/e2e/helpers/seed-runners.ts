// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Direct-DB seeding for the Runners domain e2e specs — the runner rows, the cloud identity a
// DEPLOYED runner needs, and the global warm pool the left column renders. Owned by the runners
// lane (AUTHORING.md → "Seeds — one file per domain"); `helpers/seed.ts` belongs to the seams and
// is imported here for its `Owner` type only.
//
// WHY A DEPLOYED RUNNER IS A *SEED* AND NOT A UI FLOW: `RunnerActions` shows Destroy only when
// `operator !== "managed" && provisioning === "deployed" && cloud_identity_id && metadata.deploy_config`
// (components/runners/runner-actions.tsx). The console can only reach that state by running a real
// DEPLOY_RUNNER job on a real cloud account, which the suite must never do — so the fixture is a
// row. `seedDeployedRunner` is the one place that shape is written down; a spec that hand-rolls it
// and drops `deploy_config` silently gets the *Remove* control instead and asserts nothing about
// destroy.
//
// Inserts run as the owner DB role (RLS bypassed), so every runner row sets BOTH user_id AND org_id
// to the target persona — the app reads them through RLS-scoped queries and would not see them
// otherwise. Enums (exact): runner_status = ONLINE|OFFLINE|DRAINING; runner_operator = self|managed;
// runner_provisioning = registered|deployed (NULL for managed).

import { db } from "./db";
import type { Owner } from "./seed";

/** A seeded runner row — id for DB assertions, name for the card locator. */
export interface SeededRunner {
	id: string;
	name: string;
}

/** Every runner id this worker has seeded and not yet swept — see `purgeSeededRunners`. */
const seededRunnerIds: string[] = [];

/** Runners a spec created THROUGH THE UI, which have no id here — see `trackUiRunner`. */
const uiCreatedRunners: { userId: string; name: string }[] = [];

/**
 * Registers a runner the spec created through the Add-runner sheet so the sweep removes it too.
 *
 * Without this the two "register a runner" tests leak a row per run, and the leak is not
 * cosmetic: `shows the empty-runners first-run state when the org has no runners` asserts the
 * team org is empty, so the second leaked runner turns that test permanently red. The old
 * `name like 'e2e-%'` sweep caught these by accident; a precise sweep has to be told.
 */
export function trackUiRunner(userId: string, name: string): void {
	uiCreatedRunners.push({ userId, name });
}

/**
 * Retries a DB write on a transient Postgres deadlock (40P01).
 *
 * The runners table is written by the app's heartbeat/claim paths while a spec seeds it, and a
 * seed that dies on a deadlock reads as a product failure. Bounded at 4 retries so a REAL wedge
 * still surfaces instead of hanging the test out to its 90s budget.
 */
async function withDeadlockRetry<T>(fn: () => Promise<T>): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await fn();
		} catch (err) {
			const code = (err as { code?: string }).code;
			if (code === "40P01" && attempt < 4) {
				await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
				continue;
			}
			throw err;
		}
	}
}

/**
 * Inserts a self-operated runner for a persona. `provisioning: "registered"` (the default) is the
 * bring-your-own shape and renders the Remove control; "deployed" needs a cloud identity AND a
 * deploy_config to render Destroy — use {@link seedDeployedRunner} rather than assembling it here.
 *
 * `is_default` defaults to false on purpose: `idx_runners_one_default_per_user` is a partial UNIQUE
 * index, so two seeded defaults for one persona collide and take both specs down.
 */
export async function seedRunner(
	owner: Owner,
	opts: {
		name: string;
		provisioning?: "registered" | "deployed";
		status?: "ONLINE" | "OFFLINE" | "DRAINING";
		cloudIdentityId?: string | null;
		version?: string | null;
		location?: string | null;
		supportedProviders?: string[] | null;
		isDefault?: boolean;
		deployConfig?: boolean;
	},
): Promise<SeededRunner> {
	const sql = db();
	const provisioning = opts.provisioning ?? "registered";
	const wantsDeployConfig = opts.deployConfig ?? provisioning === "deployed";
	const metadata = wantsDeployConfig
		? sql.json({
				deploy_config: {
					region: "eu-central-1",
					cloud_provider: "aws",
					image_tag: "latest",
				},
			})
		: sql.json({});
	const [row] = await withDeadlockRetry(
		() => sql<{ id: string }[]>`
			insert into runners ${sql({
				user_id: owner.userId,
				org_id: owner.orgId,
				name: opts.name,
				operator: "self",
				provisioning,
				token_hash: `e2e-hash-${Math.random().toString(36).slice(2)}`,
				status: opts.status ?? "OFFLINE",
				cloud_identity_id: opts.cloudIdentityId ?? null,
				version: opts.version ?? null,
				location: opts.location ?? null,
				supported_providers: opts.supportedProviders ?? null,
				is_default: opts.isDefault ?? false,
				metadata,
			})}
			returning id`,
	);
	seededRunnerIds.push(row.id);
	return { id: row.id, name: opts.name };
}

/**
 * Inserts a verified/connected cloud identity scoped to the persona's org. Written here rather than
 * reused from `seed.ts` so a runner spec's cleanup can delete exactly the row it created — the
 * shared helper's rows are named for the connectors domain and swept by other lanes.
 */
export async function seedRunnerCloudIdentity(
	owner: Owner,
	opts: { name?: string; provider?: string } = {},
): Promise<{ id: string }> {
	const sql = db();
	const [row] = await sql<{ id: string }[]>`
		insert into cloud_identities ${sql({
			user_id: owner.userId,
			org_id: owner.orgId,
			scope: "org",
			provider: opts.provider ?? "aws",
			name: opts.name ?? `e2e-runner-identity-${Date.now()}`,
			credentials: sql.json({ role_arn: "arn:aws:iam::123456789012:role/e2e" }),
			is_verified: true,
			status: "connected",
			verified_account_id: "123456789012",
		})}
		returning id`;
	return row;
}

/** A deployed runner plus the identity it hangs off — both ids, so a spec can sweep both. */
export interface SeededDeployedRunner {
	runner: SeededRunner;
	identityId: string;
}

/**
 * THE DESTROY FIXTURE. A self-operated runner in the `deployed` provisioning mode, attached to a
 * connected cloud identity and carrying a `deploy_config` — the exact conjunction
 * `RunnerActions.hasCloudResources` tests before it renders Destroy.
 *
 * Seeded ONLINE by default: `RunnerSelectPopover` only lets you pick a runner that is ONLINE, and
 * the destroy job it queues is the runner reassignment target. Nothing here executes tofu — the
 * spec stops at "a DESTROY_RUNNER job is QUEUED", per AUTHORING.md's "What NOT to test".
 */
export async function seedDeployedRunner(
	owner: Owner,
	opts: { name: string; status?: "ONLINE" | "OFFLINE" | "DRAINING" },
): Promise<SeededDeployedRunner> {
	const identity = await seedRunnerCloudIdentity(owner, {
		name: `e2e-runner-destroy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	});
	const runner = await seedRunner(owner, {
		name: opts.name,
		provisioning: "deployed",
		status: opts.status ?? "ONLINE",
		cloudIdentityId: identity.id,
	});
	return { runner, identityId: identity.id };
}

/** How many DESTROY_RUNNER jobs target a runner — the destroy assertions' one read. */
export async function destroyJobCount(runnerId: string): Promise<number> {
	const rows = await db()<{ id: string }[]>`
		select id from jobs
		where job_type = 'DESTROY_RUNNER'
		  and config_snapshot->>'runner_id' = ${runnerId}`;
	return rows.length;
}

/** Whether a runner row still exists (the remove/cancel assertions' one read). */
export async function runnerExists(runnerId: string): Promise<boolean> {
	const rows = await db()<{ id: string }[]>`select id from runners where id = ${runnerId}`;
	return rows.length > 0;
}

/** Reads a runner's persisted default flag (the star toggle asserts the OUTCOME, not the toast). */
export async function runnerIsDefault(runnerId: string): Promise<boolean | null> {
	const rows = await db()<{ is_default: boolean }[]>`
		select is_default from runners where id = ${runnerId}`;
	return rows[0]?.is_default ?? null;
}

/**
 * Deletes exactly the runners THIS worker seeded and has not yet swept.
 *
 * The sweep it replaces was `delete from runners where user_id = … and name like 'e2e-%'`, which
 * is every runner test's rows, not the caller's. Under `fullyParallel` that is a test deleting a
 * sibling's fixture mid-assertion from another worker — invisible, and it reads as the product
 * losing a runner. Playwright runs a worker's tests one at a time and each worker gets its own
 * module instance, so this list holds this test's rows (plus any an earlier test in the same
 * worker left behind, which is by then finished with them).
 *
 * A row already deleted through the UI is simply not there — `delete … in (…)` is a no-op for it.
 */
export async function purgeSeededRunners(): Promise<void> {
	const sql = db();
	if (seededRunnerIds.length > 0) {
		const ids = seededRunnerIds.splice(0);
		await withDeadlockRetry(() => sql`delete from runners where id in ${sql(ids)}`);
	}
	for (const r of uiCreatedRunners.splice(0)) {
		await withDeadlockRetry(
			() => sql`delete from runners where user_id = ${r.userId} and name = ${r.name}`,
		);
	}
}

/** Drops a seeded identity and any jobs that reference it (jobs first — FK). */
export async function purgeSeededIdentity(identityId: string): Promise<void> {
	const sql = db();
	await sql`delete from jobs where cloud_identity_id = ${identityId}`;
	await sql`delete from cloud_identities where id = ${identityId}`;
}

/** A seeded warm pool — the id is the row, the label is what the card and its dialog say. */
export interface SeededFleetPool {
	id: string;
	label: string;
	provider: string;
}

/**
 * Ensures ONE warm pool exists, so the runners page's left column has a `PoolCard` to drive.
 *
 * `fleet_pools` is GLOBAL platform config — no `org_id`, no RLS (schema/fleet.ts), read through
 * `getServiceDb()` and gated by the `fleet` PDP resource. Three consequences the callers depend on:
 *
 *   1. It is a SINGLETON, not per-persona. `idx_fleet_pools_provider` is a partial UNIQUE index on
 *      `provider WHERE deleting = false`, so this reads-then-inserts and tolerates a concurrent
 *      worker winning the race (23505 → re-read).
 *   2. It is NEVER torn down by a spec. `deleteFleetPool` sets `deleting = true` (a reconciled
 *      teardown, not a delete) and the pool is a platform row no test owns — which is also why the
 *      registry's `runners.pool.delete` is only ever OPENED and CANCELLED here.
 *   3. It is only rendered on a SELF-MANAGED deployment: `getFleetPoolViews` returns nothing when
 *      `deploymentMode() === "hosted"`, and `runners-client.tsx` hides the whole Pools section
 *      behind `!isHosted`. The release gate never sets `ALETHIA_DEPLOYMENT_MODE=hosted`
 *      (.github/workflows/release-gate.yml says why), so the section renders there.
 *
 * `hetzner` on purpose: it is the fleet substrate the controller actually supports, and it is not a
 * provider any other spec's fixtures use, so the singleton cannot collide with one.
 */
export async function seedFleetPool(
	opts: { provider?: string; name?: string; warmMin?: number } = {},
): Promise<SeededFleetPool> {
	const sql = db();
	const provider = opts.provider ?? "hetzner";
	const name = opts.name ?? "e2e-fleet-pool";

	const read = async (): Promise<SeededFleetPool | null> => {
		const rows = await sql<{ id: string; name: string | null }[]>`
			select id, name from fleet_pools
			where provider = ${provider} and deleting = false
			limit 1`;
		const row = rows[0];
		return row ? { id: row.id, label: row.name ?? provider, provider } : null;
	};

	const existing = await read();
	if (existing) return existing;

	try {
		const [row] = await sql<{ id: string }[]>`
			insert into fleet_pools ${sql({
				provider,
				name,
				warm_min: opts.warmMin ?? 1,
				locations: ["fsn1"],
				enabled: true,
				deleting: false,
			})}
			returning id`;
		return { id: row.id, label: name, provider };
	} catch (err) {
		// A parallel worker won the partial-unique race — re-read rather than fail.
		if ((err as { code?: string }).code !== "23505") throw err;
		const raced = await read();
		if (!raced) throw err;
		return raced;
	}
}
