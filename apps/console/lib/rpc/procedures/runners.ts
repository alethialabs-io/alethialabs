// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getPdp } from "@/lib/authz";
import { authorize, authorizeQuiet } from "@/lib/authz/guard";
import { type Actor, ForbiddenError } from "@/lib/authz/types";
import { deploymentMode } from "@/lib/billing/config";
import { getServiceDb, withActorScope } from "@/lib/db";
import {
	type CloudProvider,
	type FleetPool,
	fleetPools,
	jobs,
	type ProvisionJobType,
	projects,
	type Runner,
	runnerReleases,
	runners,
} from "@/lib/db/schema";
import {
	computeUtilizationPct,
	estimatePoolCostEur,
	fleetServerType,
	hourlyRateEur,
} from "@/lib/fleet/costs";
import { latestReleaseVersion, type ManagedRunnerRow, managedRunnerRowsForProvider } from "@/lib/fleet/queue";
import { jobMinutesByProvider, provisionedHoursByProvider, queryProvisionedHours } from "@/lib/queries/runner-usage";
import { type RunnersPage, type RunnersQuery, runnersPage } from "@/lib/queries/runners";
import { query } from "@/lib/rpc/base";

// The runners domain's reads (ADR 0005 D1, #6123). The runners route used to poll ~8 server-action
// POSTs every 10 s — the grid's page, the four reads `fetchRunnersData` made one by one from the
// browser, and the three behind `fetchFleetData`. Their bodies live here now, behind four GET
// procedures the route prefetches in-process, and the change stream (`runners` / `fleet` topics,
// lib/query/topics.ts) replaces the poll.
//
// NO RUNNER ROW TRAVELS WHOLE. Every runner read below selects `RUNNER_COLUMNS` and maps it to
// `RunnerView`. The credential column and the JSONB `metadata` column are never selected — not even
// into server memory: the two facts the UI needs from `metadata` (whether a deploy config is
// recorded, and a managed runner's VM id) are computed in SQL, so nothing else stored there can be
// spread into a view by a later edit. `org_id` IS selected and reduced on the server to `is_default`
// and `personal_elsewhere`. tests/lib/rpc/runners-procedures.test.ts pins the projection (no
// credential, no metadata) and the view's exact key set; tests/integration/runners-org-bounded.test.ts
// checks the wire against the stored hashes and a stored secret.

/** A runner release as the console shows it (dates as ISO strings). */
export interface RunnerReleaseInfo {
	version: string;
	release_notes: string;
	released_at: string;
	github_release_url: string | null;
	commit_sha: string | null;
	is_breaking: boolean;
}

const RELEASE_FIELDS = {
	version: runnerReleases.version,
	release_notes: runnerReleases.release_notes,
	released_at: runnerReleases.released_at,
	github_release_url: runnerReleases.github_release_url,
	commit_sha: runnerReleases.commit_sha,
	is_breaking: runnerReleases.is_breaking,
} as const;

/** Normalizes a release row (Date → ISO string) for the browser. */
function toReleaseInfo(r: {
	version: string;
	release_notes: string;
	released_at: Date;
	github_release_url: string | null;
	commit_sha: string | null;
	is_breaking: boolean;
}): RunnerReleaseInfo {
	return { ...r, released_at: r.released_at.toISOString() };
}

/**
 * What a runner read selects: the columns a runner surface renders, `org_id` (reduced on the server
 * to `is_default` / `personal_elsewhere`, never sent), and two facts derived from `metadata` IN SQL.
 * Deliberately NOT here: the credential column, the `metadata` column itself, `cloud_identity_id`
 * (only whether it is set matters, inside `in_place`), `user_id`, the deprecated `mode`,
 * `target_release_id`, `release_id`.
 */
const RUNNER_COLUMNS = {
	id: runners.id,
	name: runners.name,
	operator: runners.operator,
	provisioning: runners.provisioning,
	supported_providers: runners.supported_providers,
	status: runners.status,
	last_heartbeat: runners.last_heartbeat,
	version: runners.version,
	location: runners.location,
	is_default: runners.is_default,
	org_id: runners.org_id,
	/** A cloud identity AND a recorded deploy config: UPDATE/DESTROY can act on the runner in place. */
	in_place: sql<boolean>`(${runners.cloud_identity_id} is not null and coalesce(jsonb_typeof(${runners.metadata} -> 'deploy_config') = 'object', false))`,
	/** The VM a managed runner runs on (set at bootstrap); null when none is recorded. */
	cloud_instance_id: sql<string | null>`(${runners.metadata} ->> 'cloud_instance_id')`,
} as const;

/** One selected runner row with its joined release, before it is reduced to a view. */
interface SelectedRunner {
	runner: Pick<
		Runner,
		| "id"
		| "name"
		| "operator"
		| "provisioning"
		| "supported_providers"
		| "status"
		| "last_heartbeat"
		| "version"
		| "location"
		| "is_default"
		| "org_id"
	> & { in_place: boolean; cloud_instance_id: string | null };
	release: Parameters<typeof toReleaseInfo>[0] | null;
}

/**
 * A runner as the browser receives it: the rendered columns, and two facts the database derived from
 * `metadata` and `cloud_identity_id` (neither column's value leaves the database).
 */
export interface RunnerView
	extends Pick<
		Runner,
		"id" | "name" | "operator" | "provisioning" | "supported_providers" | "status" | "last_heartbeat" | "version" | "location"
	> {
	/** The default of the ADDRESSED org (a default is chosen per org). */
	is_default: boolean;
	/** A runner of the caller's personal workspace listed from a team org: its default is chosen there. */
	personal_elsewhere: boolean;
	/** Has a cloud identity and a recorded deploy config: UPDATE/DESTROY can act on it in place. */
	in_place: boolean;
	/** The cloud VM a managed runner runs on; null for self-operated runners. */
	cloud_instance_id: string | null;
	runner_releases: RunnerReleaseInfo | null;
	/** Provisioned hours this calendar month for managed runners; null otherwise. */
	provisioned_hours: number | null;
	/** The in-flight job acting on this runner (its lifecycle job, or the job it is running), if any. */
	active_job: ActiveRunnerJob | null;
}

/** A job in flight on (or against) a runner, as its card shows it. */
export interface ActiveRunnerJob {
	id: string;
	job_type: ProvisionJobType;
	project_name: string | null;
}

/** The lifecycle job types that target a runner by id in their config snapshot. */
const RUNNER_LIFECYCLE_JOBS = new Set<ProvisionJobType>(["DEPLOY_RUNNER", "UPDATE_RUNNER", "DESTROY_RUNNER"]);

/**
 * The jobs in flight that a runner card shows, keyed by runner: a lifecycle job by the runner its
 * snapshot targets, any other job by the runner executing it; the newest wins. Read with the same
 * `view` on `job` (asked quietly) and the same RLS the job list uses — a reader who may not see jobs
 * sees runners with no job overlay, not a refused page.
 */
async function readActiveRunnerJobs(): Promise<Map<string, ActiveRunnerJob>> {
	let actor: Actor;
	try {
		// Quiet: a probe for an overlay, re-asked on every refetch, must not write an activity entry or
		// emit an event each time a reader without `view job` opens the page.
		actor = await authorizeQuiet("view", { type: "job" });
	} catch (error) {
		if (error instanceof ForbiddenError) return new Map();
		throw error;
	}
	const rows = await withActorScope(actor, (tx) =>
		tx
			.select({
				id: jobs.id,
				job_type: jobs.job_type,
				runner_id: jobs.runner_id,
				target: sql<string | null>`${jobs.config_snapshot}->>'runner_id'`,
				project_name: projects.project_name,
			})
			.from(jobs)
			.leftJoin(projects, eq(jobs.project_id, projects.id))
			.where(inArray(jobs.status, ["QUEUED", "CLAIMED", "PROCESSING"]))
			.orderBy(asc(jobs.created_at)),
	);
	const byRunner = new Map<string, ActiveRunnerJob>();
	for (const r of rows) {
		const runnerId = RUNNER_LIFECYCLE_JOBS.has(r.job_type) ? r.target : r.runner_id;
		if (runnerId) byRunner.set(runnerId, { id: r.id, job_type: r.job_type, project_name: r.project_name });
	}
	return byRunner;
}

/** `is_default`, read as "the default of the addressed org" (a default is chosen per org). */
export function defaultInOrg(orgId: string) {
	return sql<boolean>`(${runners.is_default} and ${runners.org_id} = ${orgId})`;
}

/** True when a runner sits in the caller's personal workspace while the request addresses a team org. */
function isPersonalElsewhere(runnerOrgId: string | null, actor: { userId: string; orgId: string }): boolean {
	return actor.orgId !== actor.userId && runnerOrgId === actor.userId; // authz-scope-ok
}

/** Reduces a selected row to the browser's {@link RunnerView}. */
function toRunnerView(
	{ runner, release }: SelectedRunner,
	actor: { userId: string; orgId: string },
	provisionedHours: number | null,
	activeJob: ActiveRunnerJob | null,
): RunnerView {
	const managed = runner.operator === "managed";
	return {
		id: runner.id,
		name: runner.name,
		operator: runner.operator,
		provisioning: runner.provisioning,
		supported_providers: runner.supported_providers,
		status: runner.status,
		last_heartbeat: runner.last_heartbeat,
		version: runner.version,
		location: runner.location,
		is_default: !managed && runner.is_default && runner.org_id === actor.orgId,
		personal_elsewhere: !managed && isPersonalElsewhere(runner.org_id, actor),
		in_place: runner.in_place,
		cloud_instance_id: managed ? runner.cloud_instance_id : null,
		runner_releases: release ? toReleaseInfo(release) : null,
		provisioned_hours: managed ? (provisionedHours ?? 0) : null,
		active_job: activeJob,
	};
}

/**
 * The addressed org's self/BYO runners (plus the caller's personal-workspace runners, by the RLS
 * policy's owner arm), joined with their pinned release, default first, with the actor they were
 * read as. Managed (platform-fleet) runners are excluded by RLS — {@link readManagedRunners} reads them.
 */
async function readOwnRunners(): Promise<{ actor: Actor; rows: SelectedRunner[] }> {
	const actor = await authorize("view", { type: "runner" });
	const rows = await withActorScope(actor, (tx) =>
		tx
			.select({ runner: RUNNER_COLUMNS, release: RELEASE_FIELDS })
			.from(runners)
			.leftJoin(runnerReleases, eq(runners.release_id, runnerReleases.id))
			.orderBy(desc(defaultInOrg(actor.orgId)), asc(runners.operator), asc(runners.created_at)),
	);
	return { actor, rows };
}

/** The org's own runners as views (no managed fleet) — the mention picker's and the AI tool's list. */
export async function readOwnRunnerViews(): Promise<RunnerView[]> {
	const { actor, rows } = await readOwnRunners();
	return rows.map((r) => toRunnerView(r, actor, null, null));
}

/**
 * The managed warm-fleet runners (operator='managed'), joined with their release. They have no
 * owner/org, so RLS hides them from the tenant path; they are platform infrastructure. `[]` on the
 * hosted SaaS (tenants must never see our fleet); on a self-managed deployment the operator IS the
 * customer, so they are read via the service path (RLS-bypassing) for the fleet view.
 */
async function readManagedRunners(): Promise<SelectedRunner[]> {
	await authorize("view", { type: "runner" });
	if (deploymentMode() === "hosted") return [];
	return getServiceDb()
		.select({ runner: RUNNER_COLUMNS, release: RELEASE_FIELDS })
		.from(runners)
		.leftJoin(runnerReleases, eq(runners.release_id, runnerReleases.id))
		.where(eq(runners.operator, "managed"))
		.orderBy(asc(runners.created_at));
}

/**
 * Provisioned hours per managed runner for the current calendar month (UTC), keyed by runner id.
 * Reads the platform billing ledger via the service path (RLS-denied to the app role); still-open
 * sessions are billed up to now. Never surfaced to hosted tenants.
 */
async function readManagedRunnerHours(): Promise<Map<string, number>> {
	await authorize("view", { type: "runner" });
	if (deploymentMode() === "hosted") return new Map();
	const now = new Date();
	const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	const rows = await queryProvisionedHours(getServiceDb(), { from, to: now });
	return new Map(rows.map((r) => [r.runner_id, r.provisioned_hours]));
}

/**
 * Every runner the actor can see, as views: the org's own (RLS path) then the platform's managed
 * fleet (service path, `[]` on hosted) — disjoint by construction — each with the job in flight on
 * it. The job overlay used to be joined in the browser from the org's WHOLE job history.
 */
async function readRunnerUniverse(): Promise<RunnerView[]> {
	const [own, managed, hours, active] = await Promise.all([
		readOwnRunners(),
		readManagedRunners(),
		readManagedRunnerHours(),
		readActiveRunnerJobs(),
	]);
	return [...own.rows, ...managed].map((r) =>
		toRunnerView(r, own.actor, hours.get(r.runner.id) ?? null, active.get(r.runner.id) ?? null),
	);
}

/** How many releases the Versions changelog lists. */
export const RUNNER_CHANGELOG_LENGTH = 8;

/** The most recent runner releases, newest first. */
async function readRecentReleases(limit: number): Promise<RunnerReleaseInfo[]> {
	const actor = await authorize("view", { type: "runner" });
	return withActorScope(actor, async (tx) => {
		const rows = await tx.select(RELEASE_FIELDS).from(runnerReleases).orderBy(desc(runnerReleases.released_at)).limit(limit);
		return rows.map(toReleaseInfo);
	});
}

/** Every runner, the latest release, and the changelog — the Versions panel, the add-runner dialog,
 *  the per-card default flag and the runner pickers all read this one entry. */
export interface RunnersData {
	runners: RunnerView[];
	latestRelease: RunnerReleaseInfo | null;
	/** The newest {@link RUNNER_CHANGELOG_LENGTH} releases, newest first. */
	releases: RunnerReleaseInfo[];
}

/** The unfiltered runner universe plus the release changelog (the `runners.list` read). */
export async function readRunnersData(): Promise<RunnersData> {
	const [all, releases] = await Promise.all([readRunnerUniverse(), readRecentReleases(RUNNER_CHANGELOG_LENGTH)]);
	return { runners: all, latestRelease: releases[0] ?? null, releases };
}

/**
 * The runner grid's PAGE read (#4890): the universe narrowed by `q`, plus cloud/region/version facet
 * counts over every runner the actor can see — the console filter standard's steps 5 + 6. The
 * narrowing and the facet pass are `runnersPage`'s (lib/queries/runners.ts).
 */
export async function readRunnersPage(q: RunnersQuery): Promise<RunnersPage<RunnerView>> {
	return runnersPage(await readRunnerUniverse(), q);
}

/** A runner release by version, or null (the release-notes popover). */
export async function readReleaseNotes(version: string): Promise<RunnerReleaseInfo | null> {
	const actor = await authorize("view", { type: "runner" });
	return withActorScope(actor, async (tx) => {
		const [r] = await tx.select(RELEASE_FIELDS).from(runnerReleases).where(eq(runnerReleases.version, version)).limit(1);
		return r ? toReleaseInfo(r) : null;
	});
}

// ── The managed warm-pool fleet ─────────────────────────────────────────────────────────────────

/**
 * The managed warm-pool fleet is platform-operator infrastructure (the `fleet_pools` rows are
 * global, with no org_id). On the hosted SaaS no tenant operates it — exposing it would leak our
 * fleet topology and COGS — so fleet reads/writes are only available on self-managed deployments,
 * where the operator IS the customer.
 */
function isFleetOperatorDeployment(): boolean {
	return deploymentMode() === "self-managed";
}

/** Throws on deployments where the managed fleet must not be reachable by the actor (hosted). */
export function assertFleetOperable(): void {
	if (!isFleetOperatorDeployment()) {
		throw new Error("The managed fleet is not available on this deployment.");
	}
}

/** A version (or location) and how many live runners carry it, for a pool's distribution row. */
export interface PoolTally {
	key: string;
	count: number;
	/** Version: not the target. Location: has an offline runner (location degraded). */
	flagged: boolean;
}

/** One managed warm pool's configured target joined with observed reality — the unit the Fleet
 *  sidebar renders. Derived server-side so attribution stays in one place. */
export interface FleetPoolView {
	/** The fleet_pools row id (edit/delete/pause target). */
	id: string;
	provider: CloudProvider;
	/** Optional display label; falls back to the provider name in the UI. */
	name: string | null;
	/** False = paused: the controller reconciles it as a teardown target (drains its VMs to zero +
	 *  closes their usage sessions), and its runners still show while draining. Resume rebuilds. */
	enabled: boolean;
	/** Always-warm floor (the meter's slot count). */
	target: number;
	/** Hard ceiling on instances. */
	max: number;
	/** Version every runner should converge to (pinned, or resolved from the channel). */
	targetVersion: string | null;
	/** Configured spread locations (uppercased region codes). */
	locations: string[];
	online: number;
	draining: number;
	offline: number;
	busy: number;
	/** Online runners currently running a job (the meter's hatched segments). */
	busyOnline: number;
	/** Version distribution among live (non-offline) runners, target first. */
	versions: PoolTally[];
	/** Per-location runner counts; `flagged` = the location has an offline runner. */
	locDist: PoolTally[];
	/** % of live runners already on the target version (100 when no target set). */
	rolloutPct: number;
	/** All live runners are on a single version that equals the target. */
	fullyRolled: boolean;
	/** Fewer online than the warm floor. */
	belowFloor: boolean;
	/** Below floor, or any runner offline — the pool needs attention. */
	degraded: boolean;
}

/** Build the version distribution (target first, then newest→oldest) from live runners. */
function tallyVersions(rows: ManagedRunnerRow[], targetVersion: string | null): PoolTally[] {
	const counts = new Map<string, number>();
	for (const r of rows) {
		if (r.status === "offline") continue;
		const v = r.version ?? "unknown";
		counts.set(v, (counts.get(v) ?? 0) + 1);
	}
	return Array.from(counts.entries())
		.sort(([a], [b]) => {
			if (a === targetVersion) return -1;
			if (b === targetVersion) return 1;
			return b.localeCompare(a);
		})
		.map(([key, count]) => ({ key, count, flagged: key !== targetVersion }));
}

/** Build per-location counts; a location is flagged when any of its runners is offline. */
function tallyLocations(rows: ManagedRunnerRow[]): PoolTally[] {
	const counts = new Map<string, number>();
	const down = new Set<string>();
	for (const r of rows) {
		const loc = r.location ?? "—";
		counts.set(loc, (counts.get(loc) ?? 0) + 1);
		if (r.status === "offline") down.add(loc);
	}
	return Array.from(counts.entries()).map(([key, count]) => ({ key, count, flagged: down.has(key) }));
}

/** Derive one pool view from its stored row + observed managed runners. */
function toPoolView(pool: FleetPool, targetVersion: string | null, rows: ManagedRunnerRow[]): FleetPoolView {
	const online = rows.filter((r) => r.status === "online").length;
	const draining = rows.filter((r) => r.status === "draining").length;
	const offline = rows.filter((r) => r.status === "offline").length;
	const busy = rows.filter((r) => r.busy).length;
	const busyOnline = rows.filter((r) => r.status === "online" && r.busy).length;

	const versions = tallyVersions(rows, targetVersion);
	const liveTotal = versions.reduce((sum, v) => sum + v.count, 0);
	const onTarget = versions.find((v) => v.key === targetVersion)?.count ?? 0;
	const rolloutPct = !targetVersion ? 100 : liveTotal ? Math.round((onTarget / liveTotal) * 100) : 0;
	const fullyRolled = liveTotal > 0 && versions.length === 1 && versions[0].key === targetVersion;

	const belowFloor = online < pool.warm_min;
	const degraded = belowFloor || offline > 0;

	return {
		id: pool.id,
		provider: pool.provider,
		name: pool.name,
		enabled: pool.enabled,
		target: pool.warm_min,
		max: pool.max,
		targetVersion,
		locations: pool.locations.map((l) => l.toUpperCase()),
		online,
		draining,
		offline,
		busy,
		busyOnline,
		versions,
		locDist: tallyLocations(rows),
		rolloutPct,
		fullyRolled,
		belowFloor,
		degraded,
	};
}

/** Fleet observability payload: the pool cards plus whether a real cloud provider is wired
 *  (when false, pools are advisory — the manual provider only logs desired actions). */
export interface FleetOverview {
	pools: FleetPoolView[];
	/** `FLEET_PROVIDER=hcloud` — the controller actually provisions VMs. */
	fleetProviderActive: boolean;
	/** The current actor may create/edit/delete pools (owner/admin) — gates the UI controls. */
	canManageFleet: boolean;
}

/** Resolve a pool's effective target version (a pinned version wins; else the channel resolves to
 *  the newest release). */
function targetVersionFor(pool: FleetPool, latest: string | null): string | null {
	if (pool.version) return pool.version;
	return pool.channel ? latest : null;
}

/** The live (not tearing-down) pool rows, by provider. A deleting pool is draining to zero and is
 *  neither editable nor a live capacity target. */
function livePools(): Promise<FleetPool[]> {
	return getServiceDb().select().from(fleetPools).where(eq(fleetPools.deleting, false)).orderBy(asc(fleetPools.provider));
}

/**
 * Fleet observability: every configured warm pool (including paused ones) joined with its observed
 * managed runners — capacity, rollout, version + location distribution, health. Visible to anyone
 * who can view runners; the cards are read-only (mutations gate on the `fleet` resource).
 */
export async function readFleetPoolViews(): Promise<FleetOverview> {
	// Hosted tenants don't operate the managed fleet — show nothing rather than our topology.
	if (!isFleetOperatorDeployment()) {
		return { pools: [], fleetProviderActive: false, canManageFleet: false };
	}
	const actor = await authorize("view", { type: "runner" });
	// Non-throwing capability probe (no activity write) — gates the create/edit/delete UI.
	const canManageFleet = (await getPdp().can(actor, "create", { type: "fleet" })).allowed;

	const pools = await livePools();
	const fleetProviderActive = process.env.FLEET_PROVIDER === "hcloud";
	if (pools.length === 0) return { pools: [], fleetProviderActive, canManageFleet };

	const latest = await latestReleaseVersion();
	const views = await Promise.all(
		pools.map(async (pool) => toPoolView(pool, targetVersionFor(pool, latest), await managedRunnerRowsForProvider(pool.provider))),
	);
	return { pools: views, fleetProviderActive, canManageFleet };
}

/** The raw stored pool rows for the editor form. Visible config (warmMin/locations) is not
 *  sensitive; mutations remain owner/admin-gated. */
export async function readFleetPoolConfigs(): Promise<FleetPool[]> {
	assertFleetOperable();
	await authorize("view", { type: "fleet" });
	return livePools();
}

/** One pool's month-to-date economics: COGS (provisioned hours × server rate) and warm-capacity
 *  utilization (job-minutes over offered capacity-minutes). */
export interface PoolEconomics {
	provider: string;
	provisionedHours: number;
	estCostEur: number;
	jobMinutes: number;
	utilizationPct: number;
}

/** Fleet COGS/utilization for the current month, per pool + totals. Manager-only (owner/admin). */
export interface FleetEconomics {
	/** Month-to-date: from the first of the current UTC month up to the read. The read's own instant
	 *  is not carried, so two reads of the same month answer the same window. */
	window: { from: string };
	serverType: string;
	hourlyRateEur: number;
	pools: PoolEconomics[];
	totals: { provisionedHours: number; estCostEur: number; jobMinutes: number };
}

/**
 * Month-to-date COGS + utilization for the managed fleet. Gated on `fleet:create` — the same
 * owner/admin capability `canManageFleet` is derived from — because cost data must not reach
 * viewers/operators (it's the manager gate, not a literal "create").
 */
export async function readFleetEconomics(): Promise<FleetEconomics> {
	assertFleetOperable();
	await authorize("create", { type: "fleet" });

	const now = new Date();
	const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	const db = getServiceDb();

	const [poolRows, hoursRows, minRows] = await Promise.all([
		db.select({ provider: fleetPools.provider, slots: fleetPools.slots_per_runner }).from(fleetPools),
		provisionedHoursByProvider(db, { from, to: now }),
		jobMinutesByProvider(db, { from, to: now }),
	]);

	const hoursByProvider = new Map(hoursRows.map((r) => [r.provider, r.provisioned_hours]));
	const minutesByProvider = new Map(minRows.map((r) => [r.provider, r.job_minutes]));
	const serverType = fleetServerType();

	const pools: PoolEconomics[] = poolRows.map((p) => {
		const provisionedHours = hoursByProvider.get(p.provider) ?? 0;
		const jobMinutes = minutesByProvider.get(p.provider) ?? 0;
		return {
			provider: p.provider,
			provisionedHours,
			estCostEur: estimatePoolCostEur(provisionedHours, serverType),
			jobMinutes,
			utilizationPct: computeUtilizationPct(jobMinutes, provisionedHours, p.slots),
		};
	});

	// Totals span every provider with usage (incl. "any"-attributed rows not tied to a pool).
	const totalHours = hoursRows.reduce((sum, r) => sum + r.provisioned_hours, 0);
	const totalMinutes = minRows.reduce((sum, r) => sum + r.job_minutes, 0);

	return {
		window: { from: from.toISOString() },
		serverType,
		hourlyRateEur: hourlyRateEur(serverType),
		pools,
		totals: {
			provisionedHours: totalHours,
			estCostEur: estimatePoolCostEur(totalHours, serverType),
			jobMinutes: totalMinutes,
		},
	};
}

/**
 * The pool cards and the editor's rows, in one read. Month-to-date economics are a separate read
 * (`runners.fleetEconomics`): their aggregates over the usage ledger and the jobs table are not worth
 * re-running on every job transition, which is what keeps a pool's busy count live here.
 */
export interface FleetData extends FleetOverview {
	/** Raw stored rows — the edit form needs the knobs the view doesn't render. Manager-only. */
	configs: FleetPool[];
}

/** Pool views, plus the raw configs + economics when the actor can manage the fleet. */
export async function readFleetData(): Promise<FleetData> {
	const overview = await readFleetPoolViews();
	// The raw configs are manager-only (owner/admin), so they are read only when allowed.
	const configs = overview.canManageFleet ? await readFleetPoolConfigs() : [];
	return { ...overview, configs };
}

/**
 * The pools' month-to-date economics for a fleet manager, or null for everyone else and on hosted.
 * The manager gate is asked quietly first, so a viewer's page (which prefetches this) records no
 * refusal; the economics read itself then authorizes as it always has.
 */
export async function readFleetEconomicsForManager(): Promise<FleetEconomics | null> {
	if (!isFleetOperatorDeployment()) return null;
	try {
		await authorizeQuiet("create", { type: "fleet" });
	} catch (error) {
		if (error instanceof ForbiddenError) return null;
		throw error;
	}
	return readFleetEconomics();
}

// ── Inputs ──────────────────────────────────────────────────────────────────────────────────────

const facet = z.array(z.string().min(1).max(200)).max(200).optional();

/** The grid's normalized filter query on the wire — `normalizeRunnersQuery()`'s output. */
const runnersPageInput = z.object({
	search: z.string().max(200).optional(),
	clouds: facet,
	statuses: facet,
	operators: facet,
	regions: facet,
	versions: facet,
});

const releaseNotesInput = z.object({ version: z.string().min(1).max(100) });

/**
 * The runners domain's reads (ADR 0005 D1, #6123).
 *
 * - `list`: every runner the actor can see, the latest release and the changelog.
 * - `page`: the grid — the universe narrowed by the URL's filters, facets over all of it.
 * - `fleet`: the warm pools (self-managed only; empty on hosted).
 * - `fleetEconomics`: the pools' month-to-date cost and utilization (managers only; null otherwise).
 * - `releaseNotes`: one release, when a version popover opens.
 *
 * None takes a runner or pool id: every runner read is the actor's whole visible set, answered under
 * RLS for the org's own runners, so another org's row cannot be asked for by id.
 */
export const runnersRouter = {
	list: query.handler(() => readRunnersData()),
	page: query.input(runnersPageInput).handler(({ input }) => readRunnersPage(input)),
	fleet: query.handler(() => readFleetData()),
	fleetEconomics: query.handler(() => readFleetEconomicsForManager()),
	releaseNotes: query.input(releaseNotesInput).handler(({ input }) => readReleaseNotes(input.version)),
};
