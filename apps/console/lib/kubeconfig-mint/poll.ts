// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Step 5 of the kubeconfig mint channel (#5281): the client polls for its sealed result.
//
// SCOPE. Every read here runs on the RLS-enforced app role (withActorScope), where the
// kubeconfig_mint_requests policy is org- AND actor-scoped: a teammate in the same org cannot see the
// row, so cannot consume it either. The WHERE clauses name the org, the actor, the cluster and the id
// as well, so the query means the same thing on a database whose RLS was somehow off.
//
// WHICH CREDENTIAL (#5310). The person is not enough: every service token a person mints acts AS that
// person, so person-scoping let one of their tokens consume another's mint. The WHERE clause also
// names the credential the row is bound to — the token's id, or "a session" (service_token_id IS
// NULL). That predicate is the binding; RLS stays person-scoped, because the session GUCs carry no
// credential to compare against.
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

import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { withActorScope } from "@/lib/db";
import { jobs, kubeconfigMintRequests, projectCluster } from "@/lib/db/schema";
import type {
	KubeconfigMintShape,
	KubeconfigMintTier,
} from "@/lib/db/schema/enums";
import type { CliKubeconfigMintPollResponse } from "@/lib/validations/cli-contract";
import { type MintClient, type MintCredential, writeMintAudit } from "./audit";
import type { CollectGate } from "./gates";
import { KUBECONFIG_MINT_UNKNOWN_FAILURE } from "./reasons";
import type { MintActor } from "./request";

/** Who is polling, and from where (for the delivery audit row). */
export interface MintPollInput {
	actor: MintActor;
	clusterId: string;
	mintId: string;
	client: MintClient;
	/** The credential polling. It must be the one the mint is bound to, or the mint is not found. */
	credential: MintCredential;
	sourceIp: string | null;
	/**
	 * Re-checks the actor's authority for the row's tier (lib/kubeconfig-mint/gates.ts, #5667). A poll
	 * that hands nothing over asks `probe` (records nothing); the poll that hands over a `ready` mint
	 * asks `enforce` (records, and decides afresh) immediately before consuming it. So a person demoted
	 * between the request and the hand-over does not collect an admin credential they could no longer
	 * request, and waiting for a mint writes no activity row.
	 */
	gate: CollectGate;
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
 * Answers one poll. `not-found` covers a mint that never existed, belongs to someone else or to
 * another of the same person's credentials, names a different cluster, or was already swept; `consumed` is a `ready` mint another poll took first.
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
		// THE CREDENTIAL BINDING (#5310). actor_user_id is the person, and every service token that
		// person minted acts as them — so without this a sibling token could consume the mint and
		// deny the real requester. A token sees only its own mints; a session only a session's.
		input.credential.kind === "service_token"
			? eq(kubeconfigMintRequests.service_token_id, input.credential.tokenId)
			: isNull(kubeconfigMintRequests.service_token_id),
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

		// THE TIER RE-CHECK, AND WHEN IT RECORDS (#5667). Only a live `ready` row is a hand-over: it is
		// the one branch below that returns credential material. That branch gets the recording,
		// enforcing check — decided now, by the PDP, not carried over from an earlier poll's probe — so
		// one admin hand-over is one activity row, and a person who lost access_admin mid-mint is
		// refused (and the refusal recorded) before the DELETE can run. Every other branch hands over
		// nothing, so it only probes: still refusing a demoted person, recording nothing — a poll every
		// two seconds while a mint is pending is waiting, not access. An expired `ready` row is not a
		// hand-over either; it is answered `expired` below and never consumed.
		const handover = row.status === "ready" && !row.expired_now;
		const allowed = handover
			? await input.gate.enforce(row.tier)
			: await input.gate.probe(row.tier);
		if (!allowed) return { ok: false, refusal: "forbidden" };

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
			credential: input.credential,
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
