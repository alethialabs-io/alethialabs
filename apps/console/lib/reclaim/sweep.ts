// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The orphan reclaim sweep: find resources an interrupted job created in the cloud but never recorded
// in tofu state, and delete them before they bill forever.
//
// Scope, honestly stated: #530 (per-state-object serialization + releasing a killed tofu's lock)
// removed the DOMINANT cause of orphans. OpenTofu persists state to the HTTP backend as it creates
// each resource, so a killed apply normally leaves its work IN state, where an ordinary destroy finds
// it. The one incident that produced a true orphan did so because the apply's state writes were
// FENCED mid-run. Nothing fences a live writer now.
//
// So this is a BACKSTOP, for the residue that no locking can fix: a runner OOMs or its host dies in
// the window between the cloud API returning "created" and tofu persisting that fact. Rare — and
// exactly the case where nothing else will ever clean up.
//
// Every deletion must clear every guard in guards.ts. The adapters list; this decides; and it writes
// what it decided BEFORE it acts, so a sweep that goes wrong is legible after the fact.

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { jobs, projectEnvironments, projects } from "@/lib/db/schema";
import { registerLoop, superviseLoop } from "@/lib/observability/heartbeats";
import { log } from "@/lib/observability/log";
import { stateKeyForJob } from "@/lib/storage/tofu-state";
import { decide, orderForDelete, assertUsableSelector, reclaimEnabled } from "./guards";
import { adapterFor } from "./providers";
import { stateNativeIds } from "./state";
import type { LabelSelector, ReclaimDecision } from "./types";

/** A job flagged orphan_risk whose environment may hold untracked cloud resources. */
interface OrphanJob {
	id: string;
	provider: string | null;
	cloud_identity_id: string | null;
	project_id: string | null;
	environment_id: string | null;
	project_name: string | null;
	environment_name: string | null;
	started_at: Date | null;
	job_type: string;
	// The row's own type — stateKeyForJob reads runner_id out of it for runner-lifecycle jobs, so it
	// must be the real snapshot shape rather than an invented `unknown`.
	config_snapshot: typeof jobs.$inferSelect.config_snapshot;
}

/**
 * The namespace separator each cloud's tag style uses for the platform sweep handle. Mirrors the tag
 * styles in packages/core/cloud/tags.go — AWS/Azure/Alibaba take colon-namespaced tag keys, while GCP
 * and Hetzner labels forbid a colon and use an underscore. A provider absent here has no handle we can
 * scope to, and so is never swept.
 */
const HANDLE_SEP: Record<string, string> = {
	aws: ":",
	azure: ":",
	alibaba: ":",
	gcp: "_",
	hetzner: "_",
};

/**
 * The environment's label selector, derived from the DATABASE — never from the runner's report.
 *
 * That matters more than it looks: the orphan case is precisely the case where the runner died without
 * telling us anything, so `execution_metadata.cluster_name` may not exist. The environment UUID always
 * does.
 *
 * We scope on the PLATFORM SWEEP HANDLE (`alethia:environment-id` / `alethia_environment-id`), which
 * packages/core/cloud/tags.go emits on every taggable resource of every cloud for exactly this purpose
 * — "so a guarded sweeper can scope destroys to one environment". It is always emitted, and the base
 * tags sit on the merge RHS so no classification dimension can shadow it.
 *
 * An earlier version of this scoped on `cluster=<project>-<env>`. That is a Hetzner-only label — the
 * AWS/GCP/Azure/Alibaba templates never stamp it — so the sweep would have silently matched nothing on
 * four of five clouds. Fail-safe, but useless. The handle is also a UUID rather than a name, which is
 * strictly harder to collide with someone else's resources.
 */
export function selectorForJob(job: OrphanJob): LabelSelector | null {
	if (!job.provider || !job.environment_id) return null;
	const sep = HANDLE_SEP[job.provider];
	if (!sep) return null;
	return { key: `alethia${sep}environment-id`, value: job.environment_id };
}

/** Jobs flagged orphan_risk that have not yet been swept. */
async function orphanJobs(limit: number): Promise<OrphanJob[]> {
	return getServiceDb()
		.select({
			id: jobs.id,
			provider: jobs.provider,
			cloud_identity_id: jobs.cloud_identity_id,
			project_id: jobs.project_id,
			environment_id: jobs.environment_id,
			project_name: projects.project_name,
			environment_name: projectEnvironments.name,
			started_at: jobs.started_at,
			job_type: jobs.job_type,
			config_snapshot: jobs.config_snapshot,
		})
		.from(jobs)
		.leftJoin(projects, eq(projects.id, jobs.project_id))
		.leftJoin(
			projectEnvironments,
			eq(projectEnvironments.id, jobs.environment_id),
		)
		.where(
			and(
				sql`${jobs.execution_metadata}->>'orphan_risk' = 'true'`,
				// Swept once. A second pass would re-list an empty selector and do nothing, but the flag
				// is the queue — leaving it set would re-sweep forever.
				sql`${jobs.execution_metadata}->>'orphan_swept_at' IS NULL`,
				isNotNull(jobs.cloud_identity_id),
			),
		)
		.limit(limit);
}

/** Merges a patch into the job's execution_metadata. */
async function stamp(jobId: string, patch: Record<string, unknown>): Promise<void> {
	await getServiceDb()
		.update(jobs)
		.set({
			execution_metadata: sql`coalesce(${jobs.execution_metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
			updated_at: new Date(),
		})
		.where(eq(jobs.id, jobId));
}

/**
 * Records what the sweep INTENDS to do — before it does any of it.
 *
 * The ordering is the point. If the sweep dies halfway through deleting (a crash, a deploy, a network
 * partition), the intent is already durable, so what it was doing to which resources is answerable
 * afterwards. A trail written only on completion is exactly the trail you do not have when you need it.
 *
 * It also stamps `orphan_swept_at`, which is what removes the job from the queue — so a sweep that
 * crashes mid-delete does NOT come back and re-run its deletes on the next tick.
 */
async function recordPlan(
	jobId: string,
	decisions: ReclaimDecision[],
): Promise<void> {
	await stamp(jobId, {
		orphan_swept_at: new Date().toISOString(),
		orphan_sweep: {
			considered: decisions.length,
			// The full decision trail — including what was KEPT and why. When an automated process
			// deletes infrastructure, "what did it decline to touch, and on what grounds" is the
			// question you need answered afterwards.
			decisions: decisions.map((d) => ({
				native_id: d.resource.native_id,
				kind: d.resource.kind,
				name: d.resource.name,
				action: d.action,
				reason: d.reason,
			})),
		},
	});
}

/** Records what the sweep actually managed to delete, once it is done. */
async function recordOutcome(
	jobId: string,
	deleted: string[],
	failed: { native_id: string; error: string }[],
): Promise<void> {
	await stamp(jobId, { orphan_sweep_result: { deleted, failed } });
}

/**
 * Sweeps ONE orphan-risk job: lists the cloud under the environment's label selector, diffs against
 * tofu state, and deletes only what clears every guard. Returns the decisions taken.
 *
 * Report-only unless ALETHIA_ORPHAN_RECLAIM is explicitly on — auto-deleting infrastructure is opt-in,
 * never something a deploy can drift into by forgetting a variable.
 */
export async function sweepJob(job: OrphanJob): Promise<ReclaimDecision[]> {
	if (!job.provider || !job.cloud_identity_id) return [];
	const adapter = adapterFor(job.provider);
	if (!adapter) return [];

	const selector = selectorForJob(job);
	// Fail-closed: no selector ⇒ no filter ⇒ we would be listing (and then deleting from) the whole
	// account. Refuse loudly rather than sweep broadly.
	assertUsableSelector(selector);

	// Nothing older than the job can be its orphan. A job that never started cannot have created
	// anything, so there is nothing to reclaim and no safe lower bound to reclaim against.
	if (!job.started_at) return [];

	const key = stateKeyForJob({
		job_type: job.job_type,
		project_id: job.project_id,
		environment_id: job.environment_id,
		config_snapshot: job.config_snapshot,
	});
	if ("error" in key) return [];

	const [live, tracked] = await Promise.all([
		adapter.list(job.cloud_identity_id, selector),
		stateNativeIds(key.key),
	]);

	const ctx = {
		selector,
		stateNativeIds: tracked,
		jobStartedAt: job.started_at,
	};
	const decisions = live.map((resource) => decide(resource, ctx));
	const doomed = decisions
		.filter((d) => d.action === "delete")
		.map((d) => d.resource);

	log.warn("orphan reclaim: sweep decided", {
		job_id: job.id,
		provider: job.provider,
		selector: `${selector.key}=${selector.value}`,
		considered: decisions.length,
		to_delete: doomed.length,
		enabled: reclaimEnabled(),
	});

	// BEFORE any delete. If this sweep dies halfway through, what it intended is already durable — and
	// the job is already out of the queue, so a restart cannot re-run the deletes.
	await recordPlan(job.id, decisions);

	const deleted: string[] = [];
	const failed: { native_id: string; error: string }[] = [];

	if (reclaimEnabled()) {
		for (const resource of orderForDelete(doomed, adapter.deleteOrder)) {
			try {
				await adapter.delete(job.cloud_identity_id, resource);
				deleted.push(resource.native_id);
				log.warn("orphan reclaim: DELETED an untracked cloud resource", {
					job_id: job.id,
					native_id: resource.native_id,
					kind: resource.kind,
				});
			} catch (err) {
				// A failed delete is not fatal to the sweep — the others may still succeed, and the
				// failure is recorded so an operator can finish the job by hand.
				failed.push({ native_id: resource.native_id, error: String(err) });
			}
		}
	}

	await recordOutcome(job.id, deleted, failed);
	return decisions;
}

/** The reclaim loop's id + cadence. Slow on purpose: orphans are rare and deletion is irreversible. */
const RECLAIM_LOOP_ID = "orphan-reclaim";
const RECLAIM_INTERVAL_MS = 5 * 60 * 1000;

const globalForReclaim = globalThis as unknown as {
	__alethiaOrphanReclaim?: NodeJS.Timeout;
};

/**
 * Starts the periodic orphan-reclaim sweep in-process (idempotent across HMR/instances), mirroring
 * startConnectionSweeper. Heartbeat-supervised so /health can see it ticking.
 */
export function startOrphanReclaim(): void {
	if (globalForReclaim.__alethiaOrphanReclaim) return;
	if (!process.env.ALETHIA_DATABASE_URL) return; // no DB configured yet

	registerLoop(RECLAIM_LOOP_ID, { intervalMs: RECLAIM_INTERVAL_MS });
	globalForReclaim.__alethiaOrphanReclaim = setInterval(() => {
		void superviseLoop(RECLAIM_LOOP_ID, () => sweepOrphans());
	}, RECLAIM_INTERVAL_MS);
}

/** Sweeps all pending orphan-risk jobs. Driven by the background loop, like the inventory sweep. */
export async function sweepOrphans(limit = 10): Promise<number> {
	const pending = await orphanJobs(limit);
	let swept = 0;
	for (const job of pending) {
		try {
			await sweepJob(job);
			swept++;
		} catch (err) {
			// A refusing guard (no selector, unreadable state) throws. That must not wedge the loop for
			// every other job — log it and move on.
			log.error("orphan reclaim: sweep failed", {
				job_id: job.id,
				err: String(err),
			});
		}
	}
	return swept;
}
