// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { z } from "zod";
import {
	type CloudIdentityOption,
	getVerifiedCloudIdentities,
} from "@/app/server/actions/aws/identities";
import { getProjectAsFormData } from "@/app/server/actions/projects";
import { auth } from "@/lib/auth";
import { getOwner } from "@/lib/auth/owner";
import { authorize, currentActor } from "@/lib/authz/guard";
import { meteringFailed, recordAiUsage } from "@/lib/billing/ai-quota";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { isGitProvider } from "@/lib/connectors/git-providers";
import { withActorScope } from "@/lib/db";
import { type GitProvider, jobs, projects } from "@/lib/db/schema";
import { jobVisibleTo } from "@/lib/jobs/visibility";
import { pickFreeSlug, RESERVED_PROJECT_CHILD_SLUGS } from "@/lib/routing";
import { query } from "@/lib/rpc/base";
import { inferStack } from "@/lib/scanner/infer";
import type { ScanProposal } from "@/lib/scanner/schema";
import { inferredStackToFormData } from "@/lib/scanner/to-project";
import { slugify } from "@/lib/utils/slugify";
import {
	deriveDuplicateName,
	PROJECT_NAME_MAX_LENGTH,
} from "@/lib/validations/project-form.schema";

// THE PROJECTS DOMAIN'S READS (ADR 0005 D1, #6131) — what the create flow (`/{org}/~/new`) and the
// cross-cloud duplicate dialog read. The bodies MOVED here, out of `"use server"` modules:
//   · readScanStatus / readScanProposal ← app/server/actions/scanner.ts getScanProposal (deleted)
//   · readDuplicateTargets              ← app/server/actions/projects.ts getProjectDuplicateSummary
//                                         (deleted) + the dialog's own getVerifiedCloudIdentities
//   · readNameAvailability              — new: the Configure screen's inline name check (F035)
//   · readLinkedGitProviders            — the caller's linked git accounts. Not `getLinkedProviders`
//                                         (app/server/actions/identities.ts, which the selector on
//                                         other screens still calls): that one answers [] on ANY
//                                         failure, and a read that turns an outage into "nothing is
//                                         linked" would render the Link panel as if it were true.
//
// The shell's project LIST is `workspace.projects` (#6114); a write that changes it invalidates that
// key, and the `projects` topic carries other people's changes.

/** Narrow a free-form provider string to a known slug (no casts). */
function toSlug(p: string): CloudProviderSlug {
	return p === "gcp" || p === "azure" ? p : "aws";
}

// ── The import flow's scan (`?scan=<jobId>`) ─────────────────────────────────────────────────────

/**
 * Where a repository scan is, WITHOUT reading what it found. `SCANNED` means the runner has written
 * the repo digest; the proposal is then a separate read ({@link readScanProposal}).
 *
 * TWO READS, NOT ONE, because they cost different amounts. This one is a single indexed row read and
 * is what the `jobs` topic refreshes, so the Configure screen learns the scan finished within a
 * second of the runner writing it — with no poll. The proposal runs a model inference (and meters
 * it) every time it is read, so it must NOT be on any topic: a busy org sends a jobs hint every
 * second, and each would have re-run — and re-billed — the inference.
 *
 * A failed or cancelled scan stays `PENDING` with that `jobStatus`, so the screen can say the scan
 * failed rather than wait forever.
 */
export type ScanStatus =
	| { status: "NOT_FOUND" }
	| { status: "PENDING"; jobStatus: string }
	| { status: "SCANNED" };

/** {@link readScanProposal}'s answer — the scan lifecycle the Configure screen renders. */
export type ScanProposalResult =
	| { status: "NOT_FOUND" }
	| { status: "PENDING"; jobStatus: string }
	| { status: "NEEDS_SETUP"; needsIdentity: boolean }
	| { status: "READY"; proposal: ScanProposal };

/**
 * The scan job addressed by `jobId`, as the two scan reads may see it: an ANALYZE_REPO job (a job of
 * any other kind is not a scan, and answers NOT_FOUND rather than "pending" forever), visible to the
 * caller under the jobs rule (`lib/jobs/visibility.ts` — these two reads are on its list), read under
 * the caller's RLS.
 */
async function scanJobWhere(jobId: string) {
	const actor = await authorize("view", { type: "job" });
	return and(eq(jobs.id, jobId), eq(jobs.job_type, "ANALYZE_REPO"), await jobVisibleTo(actor));
}

/** How many inferred stacks one process keeps (oldest dropped first). */
const INFERRED_STACKS_MAX = 256;

/**
 * Inferred stacks by scan job id, per process. The inference is a pure function of the job's digest,
 * which the runner writes once, so the first answer is the answer; caching it is what keeps a page
 * refresh, a retry or a second tab from re-running (and re-metering) a model call. Keyed by job id
 * and only ever read AFTER {@link scanJobWhere} has found the job for this caller, so the cache
 * answers nobody who could not read the job.
 */
const inferredStacks = new Map<string, ScanProposal["stack"]>();

/** Remembers one inferred stack, dropping the oldest past the bound. */
function rememberStack(jobId: string, stack: ScanProposal["stack"]): void {
	inferredStacks.set(jobId, stack);
	if (inferredStacks.size > INFERRED_STACKS_MAX) {
		const oldest = inferredStacks.keys().next().value;
		if (oldest !== undefined) inferredStacks.delete(oldest);
	}
}

/** See {@link ScanStatus}. Another tenant's job, or one that is not a scan, is NOT_FOUND. */
export async function readScanStatus(jobId: string): Promise<ScanStatus> {
	const where = await scanJobWhere(jobId);
	const actor = await currentActor();
	const job = await withActorScope(actor, async (tx) => {
		const [j] = await tx
			.select({
				status: jobs.status,
				// Whether the digest is there, asked in SQL so the digest itself never leaves the
				// database on a read the jobs topic repeats.
				scanned: sql<boolean>`coalesce(jsonb_typeof(${jobs.execution_metadata} -> 'repo_digest') = 'object', false)`,
			})
			.from(jobs)
			.where(where)
			.limit(1);
		return j ?? null;
	});
	if (!job) return { status: "NOT_FOUND" };
	return job.scanned ? { status: "SCANNED" } : { status: "PENDING", jobStatus: job.status };
}

/**
 * Build a review-ready proposal from a completed scan: the model infers an InferredStack from the
 * digest, then a deterministic mapper turns it into a guaranteed-valid Project placed on the caller's
 * first verified cloud account. The inference runs once per scan per process (`inferredStacks`); the
 * client also reads this once per scan — its observer goes inactive once it holds an answer, so no
 * topic hint, resync or focus refetches it (see {@link ScanStatus}).
 */
export async function readScanProposal(jobId: string): Promise<ScanProposalResult> {
	const where = await scanJobWhere(jobId);
	const scanActor = await currentActor();
	const job = await withActorScope(scanActor, async (tx) => {
		const [j] = await tx
			.select({
				status: jobs.status,
				execution_metadata: jobs.execution_metadata,
				config_snapshot: jobs.config_snapshot,
			})
			.from(jobs)
			.where(where)
			.limit(1);
		return j ?? null;
	});
	if (!job) return { status: "NOT_FOUND" };

	const digest = job.execution_metadata?.repo_digest ?? null;
	if (!digest) return { status: "PENDING", jobStatus: job.status };

	const repoUrl =
		typeof job.config_snapshot?.repo_url === "string" ? job.config_snapshot.repo_url : "";
	const ref = typeof job.config_snapshot?.ref === "string" ? job.config_snapshot.ref : undefined;

	// ONE inference per scan per process (see `inferredStacks`): a refresh of `/~/new?scan=`, the
	// client's retry and a second tab all answer from it, and only a real inference is metered.
	let stack = inferredStacks.get(jobId);
	if (!stack) {
		const inferred = await inferStack(digest);
		stack = inferred.stack;
		rememberStack(jobId, stack);
		// Record the inference's real token cost (credits were already charged at queue time in
		// scanRepo; this 0-credit row carries cost-of-serve only).
		void recordAiUsage({
			orgId: scanActor.orgId,
			userId: scanActor.userId,
			kind: "scan",
			credits: 0,
			source: "included",
			refId: jobId,
			model: inferred.model,
			inputTokens: inferred.inputTokens,
			outputTokens: inferred.outputTokens,
			cachedInputTokens: inferred.cachedInputTokens,
		}).catch(meteringFailed(scanActor.orgId));
	}

	const identities = await getVerifiedCloudIdentities();
	if (identities.length === 0) {
		return { status: "NEEDS_SETUP", needsIdentity: true };
	}

	const identity = identities[0];
	const provider = toSlug(identity.provider);
	const proposedProject = inferredStackToFormData(stack, {
		identityId: identity.id,
		provider,
		repoUrl,
		ref,
		services: digest.services,
	});

	return {
		status: "READY",
		proposal: { stack, proposedProject, provider, identityId: identity.id },
	};
}

// ── The import panel ─────────────────────────────────────────────────────────────────────────────

/**
 * The git providers linked to the signed-in person's login (Better Auth's account rows). No session
 * is no accounts; any OTHER failure throws, so the panel renders an error rather than the Link panel
 * — "nothing is linked" is a claim, and an outage is not evidence for it.
 */
export async function readLinkedGitProviders(): Promise<GitProvider[]> {
	if (!(await getOwner())) return [];
	const accounts = await auth.api.listUserAccounts({ headers: await headers() });
	const linked = new Set<GitProvider>();
	for (const a of accounts) if (isGitProvider(a.providerId)) linked.add(a.providerId);
	return [...linked];
}

// ── The Configure screen's name field ────────────────────────────────────────────────────────────

/** {@link readNameAvailability}'s answer. */
export interface NameAvailability {
	/** False when the org already holds this name — compared without regard to case, as the index does. */
	available: boolean;
	/** The URL slug a project of this name would get NOW: de-duplicated, as the create will do. */
	slug: string;
}

/**
 * Whether the org can take `name` for a new project, asked while the user types (F035).
 *
 * The SAME two answers `insertProjectWithDefaultFabric` (lib/queries/projects.ts) gives at create
 * time, from the same predicates: the NAME collides case-insensitively (the
 * `projects_org_id_project_name_key` index), and the SLUG is de-duplicated with `pickFreeSlug` over
 * the org's slugs plus the reserved project-child segments. So the screen can show the URL the
 * project will really get — `acme/api-2`, not `acme/api` — before it is created.
 *
 * It is a preview, not a reservation: the index still decides a race at create time, and the create's
 * refusal is still rendered beside the field. It reveals nothing the create would not: a create of
 * the same name answers "already exists" too, and only to the same caller in the same org.
 */
export async function readNameAvailability(name: string): Promise<NameAvailability> {
	const actor = await authorize("view", { type: "project" });
	const wanted = name.trim();
	const existing = await withActorScope(actor, async (tx) => {
		const rows = await tx
			.select({ slug: projects.slug, project_name: projects.project_name })
			.from(projects)
			.where(eq(projects.org_id, actor.orgId));
		return rows;
	});
	const lower = wanted.toLowerCase();
	const taken = existing.some((r) => r.project_name.toLowerCase() === lower);
	const slug = pickFreeSlug(slugify(wanted, "project"), [
		...existing.map((r) => r.slug),
		...RESERVED_PROJECT_CHILD_SLUGS,
	]);
	return { available: !taken, slug };
}

// ── The cross-cloud duplicate dialog ─────────────────────────────────────────────────────────────

/**
 * The infrastructure categories a project's default environment currently provisions — used by the
 * cross-cloud duplicate dialog to preview which managed services will be translated (cluster → GKE,
 * Aurora → Cloud SQL, …). `network` + `cluster` are always present; the rest are listed only when
 * the design actually has one. Purely a read of the design (no provisioned state).
 */
export type DuplicateCategory =
	| "network"
	| "cluster"
	| "dns"
	| "databases"
	| "caches"
	| "nosql"
	| "queues"
	| "topics"
	| "secrets";

/** Clouds with full provisioning templates + a conversion mapping — the only valid duplicate targets. */
const DUPLICATE_TARGET_PROVIDERS: readonly string[] = ["aws", "gcp", "azure", "alibaba"];

/** {@link readDuplicateTargets}'s answer: everything the duplicate dialog shows before submit. */
export interface DuplicateTargets {
	provider: CloudProviderSlug;
	projectName: string;
	categories: DuplicateCategory[];
	suggestedNames: Record<CloudProviderSlug, string>;
	/** The caller's verified cloud accounts a clone can go to: another cloud, and one we convert to. */
	identities: CloudIdentityOption[];
}

/**
 * Source provider, the service categories present, the per-target default NAME and the target
 * accounts, for the cross-cloud duplicate preview — ONE read, so the dialog opens on one round trip.
 *
 * `suggestedNames` is what pre-fills the dialog's name field, and it is keyed by target cloud
 * because the suffix NAMES that cloud — a field still reading " (aws)" after the user switched the
 * target to GCP is a wrong default, not a stale one. It is computed HERE, by the same
 * `deriveDuplicateName` the action falls back to, rather than in the client: a second derivation in
 * the dialog would be a second source of truth, and the client has no business reading the org's
 * project names to de-duplicate against. Only the source project's own name reaches the client, in
 * five pre-composed strings.
 *
 * It is a SUGGESTION and nothing here checks it against `PROJECT_NAME_MAX_LENGTH`: when the source
 * name is long enough the suggestion is over the cap and the form says so on the first render —
 * which is the honest reading, because that is precisely the project #4738 made un-duplicatable and
 * the field the user must now shorten.
 */
export async function readDuplicateTargets(projectId: string): Promise<DuplicateTargets> {
	const { formData, provider } = await getProjectAsFormData(projectId);
	const categories: DuplicateCategory[] = ["network", "cluster"];
	if (formData.dns?.enabled) categories.push("dns");
	if (formData.databases?.length) categories.push("databases");
	if (formData.caches?.length) categories.push("caches");
	if (formData.nosql_tables?.length) categories.push("nosql");
	if (formData.queues?.length) categories.push("queues");
	if (formData.topics?.length) categories.push("topics");
	if (formData.secrets?.length) categories.push("secrets");

	const actor = await currentActor();
	const takenNames = await withActorScope(actor, async (tx) => {
		const names = await tx
			.select({ project_name: projects.project_name })
			.from(projects)
			.where(eq(projects.org_id, actor.orgId));
		return names.map((n) => n.project_name);
	});
	const sourceName = formData.project.project_name;
	// A literal annotated `Record<CloudProviderSlug, string>` rather than a fold over
	// `CLOUD_PROVIDER_SLUGS`: the annotation is checked in BOTH directions, so a cloud added to the
	// slug union fails to compile here until it is given a suggestion, and one removed fails too.
	const suggestedNames: Record<CloudProviderSlug, string> = {
		aws: deriveDuplicateName(sourceName, "aws", takenNames),
		gcp: deriveDuplicateName(sourceName, "gcp", takenNames),
		azure: deriveDuplicateName(sourceName, "azure", takenNames),
		hetzner: deriveDuplicateName(sourceName, "hetzner", takenNames),
		alibaba: deriveDuplicateName(sourceName, "alibaba", takenNames),
	};

	// Only other-provider accounts on a cloud we can actually provision + convert to.
	const identities = (await getVerifiedCloudIdentities()).filter(
		(i) => i.provider !== provider && DUPLICATE_TARGET_PROVIDERS.includes(i.provider),
	);

	return { provider, projectName: sourceName, categories, suggestedNames, identities };
}

const byScanJob = z.object({ jobId: z.string().uuid() });
const byProject = z.object({ projectId: z.string().uuid() });
const byName = z.object({ name: z.string().trim().min(1).max(PROJECT_NAME_MAX_LENGTH) });

/**
 * The projects domain's read procedures (ADR 0005 D1). Pre-created and wired into the root router
 * by #6113 so no lane ever edits `router.ts` (stress test R10). Each starts from `query` in
 * `@/lib/rpc/base`.
 */
export const projectsRouter = {
	/** The git providers the CALLER has linked — the import panel's first paint (F034). */
	linkedGitProviders: query.handler(() => readLinkedGitProviders()),
	scanStatus: query.input(byScanJob).handler(({ input }) => readScanStatus(input.jobId)),
	scanProposal: query.input(byScanJob).handler(({ input }) => readScanProposal(input.jobId)),
	nameAvailability: query.input(byName).handler(({ input }) => readNameAvailability(input.name)),
	duplicateTargets: query
		.input(byProject)
		.handler(({ input }) => readDuplicateTargets(input.projectId)),
};
