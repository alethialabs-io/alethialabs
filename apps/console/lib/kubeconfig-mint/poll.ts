// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Step 5 of the kubeconfig mint channel (#5281): the client polls for its sealed result.
//
// SCOPE. Every read here runs on the RLS-enforced app role (withActorScope), where the
// kubeconfig_mint_requests policy is org- AND actor-scoped: a teammate in the same org cannot see the
// row, so cannot consume it either. The WHERE clauses name the org, the actor, the cluster and the id
// as well, so the query means the same thing on a database whose RLS was somehow off.
//
// READ ONCE. A `ready` row is served by `DELETE … RETURNING sealed_result` — the statement that reads
// the ciphertext is the statement that removes it, so two concurrent polls cannot both get it: one
// DELETE wins the row lock, and the other finds nothing and answers `consumed` (a 404). The delivery
// audit row is inserted in the same transaction, so the ciphertext never leaves without its record.
//
// EXPIRY. A row past `expires_at` is `expired` here whatever its stored status, before the sweep has
// reached it — a `ready` row is never served after its window, and the DELETE re-checks the window in
// SQL rather than trusting the read above it.
//
// A DEAD JOB. A `pending` row whose MINT_KUBECONFIG job is already terminal will never get a result —
// the runner failed or cancelled the job without posting one (a runner too old to know the job type
// does exactly that). It is answered `failed` with the generic reason at once, rather than leaving the
// client to poll out the rest of the window.

import { and, eq, gt, sql } from "drizzle-orm";
import { withActorScope } from "@/lib/db";
import { jobs, kubeconfigMintRequests, projectCluster } from "@/lib/db/schema";
import type {
	KubeconfigMintShape,
	KubeconfigMintTier,
} from "@/lib/db/schema/enums";
import type { CliKubeconfigMintPollResponse } from "@/lib/validations/cli-contract";
import type { KubeconfigMintAuditChanges } from "@/types/jsonb.types";
import { type MintClient, writeMintAudit } from "./audit";
import { KUBECONFIG_MINT_UNKNOWN_FAILURE } from "./reasons";
import type { MintActor } from "./request";

/** Who is polling, and from where (for the delivery audit row). */
export interface MintPollInput {
	actor: MintActor;
	clusterId: string;
	mintId: string;
	client: MintClient;
	credentialKind: KubeconfigMintAuditChanges["credential_kind"];
	sourceIp: string | null;
	/**
	 * Re-checks the actor's authority for the row's tier BEFORE anything is consumed. Returns false
	 * to refuse. The route passes a PDP check: a person demoted between the request and the poll does
	 * not collect an admin credential they could no longer request.
	 */
	mayCollect: (tier: KubeconfigMintTier) => Promise<boolean>;
}

/** The outcome of {@link pollKubeconfigMint}. */
export type MintPollOutcome =
	| { ok: true; body: CliKubeconfigMintPollResponse }
	| { ok: false; refusal: "not-found" | "consumed" | "forbidden" };

/** The non-secret half of a mint row: everything the poll needs before it decides to consume. */
interface MintRowHead {
	status: "pending" | "ready" | "failed" | "expired";
	tier: KubeconfigMintTier;
	shape: KubeconfigMintShape;
	ttl_seconds: number;
	job_id: string | null;
	failure_reason: string | null;
	private_endpoint: boolean | null;
	expires_at: Date;
	expired_now: boolean;
	project_id: string;
	job_status: string | null;
}

/** Job statuses after which no result will ever be posted. */
const TERMINAL_JOB: ReadonlySet<string> = new Set(["SUCCESS", "FAILED", "CANCELLED"]);

/**
 * Answers one poll. `not-found` covers a mint that never existed, belongs to someone else, names a
 * different cluster, or was already swept; `consumed` is a `ready` mint another poll took first.
 * Both reach the client as a 404 — neither says whose mint it was.
 */
export async function pollKubeconfigMint(
	input: MintPollInput,
): Promise<MintPollOutcome> {
	const { actor, clusterId, mintId } = input;
	const scoped = and(
		eq(kubeconfigMintRequests.id, mintId),
		eq(kubeconfigMintRequests.cluster_id, clusterId),
		eq(kubeconfigMintRequests.org_id, actor.orgId),
		eq(kubeconfigMintRequests.actor_user_id, actor.userId),
	);

	return withActorScope(actor, async (tx): Promise<MintPollOutcome> => {
		const [head] = await tx
			.select({
				status: kubeconfigMintRequests.status,
				tier: kubeconfigMintRequests.tier,
				shape: kubeconfigMintRequests.shape,
				ttl_seconds: kubeconfigMintRequests.ttl_seconds,
				job_id: kubeconfigMintRequests.job_id,
				failure_reason: kubeconfigMintRequests.failure_reason,
				private_endpoint: kubeconfigMintRequests.private_endpoint,
				expires_at: kubeconfigMintRequests.expires_at,
				// Judged by the database's clock, the one that set expires_at.
				expired_now: sql<boolean>`${kubeconfigMintRequests.expires_at} <= now()`,
				project_id: projectCluster.project_id,
				job_status: jobs.status,
			})
			.from(kubeconfigMintRequests)
			.innerJoin(
				projectCluster,
				eq(projectCluster.id, kubeconfigMintRequests.cluster_id),
			)
			.leftJoin(jobs, eq(jobs.id, kubeconfigMintRequests.job_id))
			.where(scoped)
			.limit(1);
		const row: MintRowHead | undefined = head;
		if (!row) return { ok: false, refusal: "not-found" };

		if (!(await input.mayCollect(row.tier))) {
			return { ok: false, refusal: "forbidden" };
		}

		if (row.status === "expired" || row.expired_now) {
			return {
				ok: true,
				body: { status: "expired", private_endpoint: row.private_endpoint },
			};
		}
		if (row.status === "pending" && row.job_status && TERMINAL_JOB.has(row.job_status)) {
			return {
				ok: true,
				body: {
					status: "failed",
					private_endpoint: row.private_endpoint,
					reason: KUBECONFIG_MINT_UNKNOWN_FAILURE,
				},
			};
		}
		if (row.status === "pending") {
			return {
				ok: true,
				body: {
					status: "pending",
					private_endpoint: row.private_endpoint,
					expires_at: row.expires_at.toISOString(),
				},
			};
		}
		if (row.status === "failed") {
			return {
				ok: true,
				body: {
					status: "failed",
					private_endpoint: row.private_endpoint,
					reason: row.failure_reason ?? KUBECONFIG_MINT_UNKNOWN_FAILURE,
				},
			};
		}

		// `ready`: consume it. The DELETE is the read.
		const [taken] = await tx
			.delete(kubeconfigMintRequests)
			.where(
				and(
					scoped,
					eq(kubeconfigMintRequests.status, "ready"),
					gt(kubeconfigMintRequests.expires_at, sql`now()`),
				),
			)
			.returning({
				sealed_result: kubeconfigMintRequests.sealed_result,
				private_endpoint: kubeconfigMintRequests.private_endpoint,
			});
		if (!taken?.sealed_result) return { ok: false, refusal: "consumed" };

		await writeMintAudit(tx, {
			event: "kubeconfig_mint.delivered",
			projectId: row.project_id,
			actorUserId: actor.userId,
			mintId,
			clusterId,
			jobId: row.job_id,
			tier: row.tier,
			shape: row.shape,
			ttlSeconds: row.ttl_seconds,
			requestExpiresAt: row.expires_at,
			client: input.client,
			credentialKind: input.credentialKind,
			sourceIp: input.sourceIp,
		});

		return {
			ok: true,
			body: {
				status: "ready",
				// The runner reports it with the ciphertext; the CHECK keeps a ready row non-null in
				// sealed_result, and the result route always writes this alongside it.
				private_endpoint: taken.private_endpoint ?? false,
				sealed: taken.sealed_result,
			},
		};
	});
}
