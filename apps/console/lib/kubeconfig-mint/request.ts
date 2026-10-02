// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Step 1 of the kubeconfig mint channel (#5281; the channel is drawn in lib/validations/cli-contract.ts):
// a client asks for a credential, and this enqueues the MINT_KUBECONFIG job that will mint it.
//
// The caller has ALREADY authenticated the actor and checked exactly the tier's action
// (`cluster:access_readonly` / `cluster:access_admin`) — see the request route. Everything here runs
// after that, and nothing here re-derives who the actor is.
//
// TENANCY. The cluster is resolved with `project_cluster.org_id = actor.orgId`; a cluster in another
// org is indistinguishable from one that does not exist (both are `not-found`, a 404). The bind-org
// trigger on kubeconfig_mint_requests refuses the same mistake again at the database.
//
// THE TRANSACTION. The job, the mint request row and the audit row are written in ONE transaction on
// the RLS-enforced app role (withActorScope): either all three commit or none does. The audit row is
// therefore committed before the 202 is sent and before any runner can claim the job — so before the
// credential can exist at all (write-before; lib/kubeconfig-mint/audit.ts).

import { and, desc, eq, sql } from "drizzle-orm";
import { assertUsageAllowed } from "@/lib/billing/usage-guard";
import { getServiceDb, withActorScope } from "@/lib/db";
import {
	cloudIdentities,
	jobs,
	kubeconfigMintRequests,
	projectCluster,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import { KUBECONFIG_MINT_REQUEST_WINDOW_SECONDS } from "@/lib/db/schema/kubeconfig-mints";
import { signedJob } from "@/lib/db/signed-job";
import { newTraceparent } from "@/lib/observability/trace";
import { notifyScaler } from "@/lib/scaler";
import type { CliKubeconfigMintRequest } from "@/lib/validations/cli-contract";
import type { KubeconfigMintAuditChanges } from "@/types/jsonb.types";
import { type MintClient, writeMintAudit } from "./audit";
import { mintShapeRefusal } from "./clouds";

/** Environment statuses with no cluster to mint against. */
const UNPROVISIONED_ENV: ReadonlySet<string> = new Set([
	"DRAFT",
	"DESTROYING",
	"DESTROYED",
]);

/** Who is asking, as the route resolved them. */
export interface MintActor {
	userId: string;
	orgId: string;
}

/** One mint request, already parsed against `cliKubeconfigMintRequest`. */
export interface MintRequestInput {
	actor: MintActor;
	clusterId: string;
	request: CliKubeconfigMintRequest;
	client: MintClient;
	credentialKind: KubeconfigMintAuditChanges["credential_kind"];
	sourceIp: string | null;
}

/** The queued mint, in the shape `kubeconfigMintWire` describes. */
interface QueuedMint {
	id: string;
	cluster_id: string;
	job_id: string;
	tier: CliKubeconfigMintRequest["tier"];
	shape: CliKubeconfigMintRequest["shape"];
	ttl_seconds: number;
	status: "pending";
	expires_at: Date;
}

/** Why a mint was not queued. Each maps to one HTTP status in the route. */
export type MintRequestRefusal =
	| "not-found"
	| "not-provisioned"
	| "unsupported-cloud"
	| "static-only";

/** The outcome of {@link requestKubeconfigMint}. */
export type MintRequestOutcome =
	| { ok: true; mint: QueuedMint }
	| { ok: false; refusal: MintRequestRefusal };

/** The cluster row a mint names, resolved inside the actor's org. */
interface MintTarget {
	clusterId: string;
	projectId: string;
	environmentId: string | null;
	environmentStatus: string | null;
	cloudIdentityId: string | null;
	provider: (typeof cloudIdentities.$inferSelect)["provider"] | null;
}

/**
 * Resolves the cluster with `org_id = orgId` — the tenancy boundary, since this read runs on the
 * service role. The cloud identity is the cluster's own placement, falling back to its project's
 * (`coalesce(project_cluster.cloud_identity_id, projects.cloud_identity_id)`, #5250 §5), never "the
 * org's first identity". Null when no such cluster exists in that org.
 */
async function resolveMintTarget(
	clusterId: string,
	orgId: string,
): Promise<MintTarget | null> {
	const [row] = await getServiceDb()
		.select({
			clusterId: projectCluster.id,
			projectId: projectCluster.project_id,
			environmentId: projectCluster.environment_id,
			environmentStatus: projectEnvironments.status,
			cloudIdentityId: cloudIdentities.id,
			provider: cloudIdentities.provider,
		})
		.from(projectCluster)
		.innerJoin(projects, eq(projectCluster.project_id, projects.id))
		.leftJoin(
			projectEnvironments,
			eq(projectEnvironments.id, projectCluster.environment_id),
		)
		.leftJoin(
			cloudIdentities,
			and(
				eq(
					cloudIdentities.id,
					sql`coalesce(${projectCluster.cloud_identity_id}, ${projects.cloud_identity_id})`,
				),
				// The identity must be the org's too. It always is when the FKs were written by the
				// app, and this makes "always" a property of the query rather than of every writer.
				eq(cloudIdentities.org_id, orgId),
			),
		)
		.where(and(eq(projectCluster.id, clusterId), eq(projectCluster.org_id, orgId)))
		.limit(1);
	return row ?? null;
}

/**
 * The config snapshot of the environment's latest SUCCESSFUL deploy — the provisioned state the
 * runner reads to find the cluster, exactly as the liveness prober does (lib/probes/dispatch.ts).
 * Null when the environment has never deployed, so there is no cluster to mint for.
 */
async function latestDeploySnapshot(
	environmentId: string,
	orgId: string,
): Promise<{ config_snapshot: (typeof jobs.$inferSelect)["config_snapshot"] } | null> {
	const [row] = await getServiceDb()
		.select({ config_snapshot: jobs.config_snapshot })
		.from(jobs)
		.where(
			and(
				eq(jobs.environment_id, environmentId),
				eq(jobs.org_id, orgId),
				eq(jobs.job_type, "DEPLOY"),
				eq(jobs.status, "SUCCESS"),
			),
		)
		.orderBy(desc(jobs.created_at))
		.limit(1);
	return row ?? null;
}

/**
 * Queues one kubeconfig mint: checks the cluster is in the actor's org, is provisioned, and can
 * mint the requested shape; applies the runner-minute usage guard (but not the daily job quota, which
 * exempts mints — #5313); then writes the MINT_KUBECONFIG job, the mint request row and the audit row in one transaction.
 *
 * Throws `UsageLimitError` from the usage guard (the route maps it to 402). Any other throw is a
 * server error and has written nothing.
 */
export async function requestKubeconfigMint(
	input: MintRequestInput,
): Promise<MintRequestOutcome> {
	const { actor, clusterId, request } = input;

	const target = await resolveMintTarget(clusterId, actor.orgId);
	if (!target) return { ok: false, refusal: "not-found" };

	const refusal = mintShapeRefusal(target.provider, request.shape);
	if (refusal) return { ok: false, refusal };

	if (
		!target.environmentId ||
		!target.environmentStatus ||
		UNPROVISIONED_ENV.has(target.environmentStatus)
	) {
		return { ok: false, refusal: "not-provisioned" };
	}
	const deploy = await latestDeploySnapshot(target.environmentId, actor.orgId);
	if (!deploy) return { ok: false, refusal: "not-provisioned" };

	// A mint runs on a runner like any other job, so its runner minutes are metered like one. It is
	// NOT checked against the community daily job quota, and does not count toward it (#5313):
	// access to your own cluster must never be what stops you deploying. It is bounded instead by the
	// route's per-user mint rate limit. See QUOTA_EXEMPT_JOB_TYPES in lib/billing/job-quota.ts.
	await assertUsageAllowed(actor.orgId);

	const environmentId = target.environmentId;
	const mint = await withActorScope(actor, async (tx) => {
		const [job] = await tx
			.insert(jobs)
			.values(
				signedJob({
					user_id: actor.userId,
					// Stamped explicitly: the tenancy is the org the mint was authorized in.
					org_id: actor.orgId,
					project_id: target.projectId,
					environment_id: environmentId,
					cloud_identity_id: target.cloudIdentityId,
					initiated_by: "user",
					job_type: "MINT_KUBECONFIG",
					config_snapshot: deploy.config_snapshot,
					status: "QUEUED",
					traceparent: newTraceparent(),
				}),
			)
			.returning({ id: jobs.id });

		const [row] = await tx
			.insert(kubeconfigMintRequests)
			.values({
				org_id: actor.orgId,
				cluster_id: target.clusterId,
				job_id: job.id,
				actor_user_id: actor.userId,
				tier: request.tier,
				ttl_seconds: request.ttl_seconds,
				shape: request.shape,
				client_public_key: request.client_public_key,
				// The database's clock, the one that stamps created_at, so the CHECK
				// expires_at > created_at and the sweep's comparison share one time source.
				expires_at: sql`now() + make_interval(secs => ${KUBECONFIG_MINT_REQUEST_WINDOW_SECONDS})`,
			})
			.returning({
				id: kubeconfigMintRequests.id,
				expires_at: kubeconfigMintRequests.expires_at,
			});

		await writeMintAudit(tx, {
			event: "kubeconfig_mint.requested",
			projectId: target.projectId,
			actorUserId: actor.userId,
			mintId: row.id,
			clusterId: target.clusterId,
			jobId: job.id,
			tier: request.tier,
			shape: request.shape,
			ttlSeconds: request.ttl_seconds,
			requestExpiresAt: row.expires_at,
			client: input.client,
			credentialKind: input.credentialKind,
			sourceIp: input.sourceIp,
		});

		const queued: QueuedMint = {
			id: row.id,
			cluster_id: target.clusterId,
			job_id: job.id,
			tier: request.tier,
			shape: request.shape,
			ttl_seconds: request.ttl_seconds,
			status: "pending",
			expires_at: row.expires_at,
		};
		return queued;
	});

	notifyScaler();
	return { ok: true, mint };
}
