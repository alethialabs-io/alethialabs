// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The audit_log rows a kubeconfig mint writes (#5250 §2 "Audit", decision 1).
//
// WRITE-BEFORE, the lib/breakglass/audit.ts discipline: the row is committed BEFORE the thing it
// records can happen. Breakglass gets that with a separate, earlier commit. Here the row rides in the
// SAME transaction as the act itself, which is stronger: the "requested" row commits with the
// MINT_KUBECONFIG job — no runner can claim a job whose audit row did not commit — and the
// "delivered" row commits with the read-once DELETE, so a ciphertext that left the console always has
// its row, and a failed audit write leaves the ciphertext where it was.
//
// What the row never carries: the credential, the ciphertext, the client's public key. It does name
// WHICH bearer asked — its kind, and for a service token its id (#5310) — which is not a secret. The shape is
// KubeconfigMintAuditChanges (types/jsonb.types.ts) and has no field that could hold one.

import type { Tx } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import type {
	KubeconfigMintShape,
	KubeconfigMintTier,
} from "@/lib/db/schema/enums";
import type { KubeconfigMintAuditChanges } from "@/types/jsonb.types";

/** Which surface asked for the mint. */
export type MintClient = "cli" | "console";

/**
 * The credential a mint is BOUND to (#5310): only this same credential may poll and collect it.
 *
 * - `session` — a signed-in person (the console, or `alethia login`). The mint is that person's.
 * - `service_token` — one CLI service token, by its `cli_service_tokens.id`. Every token a person
 *   mints acts as that person (`actor.userId` is the MINTER), so the person alone cannot tell two of
 *   their tokens apart; the token's own id can.
 */
export type MintCredential =
	| { kind: "session" }
	| { kind: "service_token"; tokenId: string };

/** Everything one mint audit row records. */
export interface MintAuditInput {
	event: KubeconfigMintAuditChanges["event"];
	projectId: string;
	actorUserId: string;
	mintId: string;
	clusterId: string;
	jobId: string | null;
	tier: KubeconfigMintTier;
	shape: KubeconfigMintShape;
	ttlSeconds: number;
	requestExpiresAt: Date;
	client: MintClient;
	credential: MintCredential;
	sourceIp: string | null;
}

/** Builds the `changes` payload for a mint audit row. Pure, so a test can read exactly what lands. */
function mintAuditChanges(input: MintAuditInput): KubeconfigMintAuditChanges {
	return {
		event: input.event,
		mint_id: input.mintId,
		cluster_id: input.clusterId,
		job_id: input.jobId,
		tier: input.tier,
		shape: input.shape,
		ttl_seconds: input.ttlSeconds,
		request_expires_at: input.requestExpiresAt.toISOString(),
		credential_expires_by: new Date(
			input.requestExpiresAt.getTime() + input.ttlSeconds * 1000,
		).toISOString(),
		client: input.client,
		credential_kind: input.credential.kind,
		// The token's id, never the token: it names the row in the console's token list.
		credential_id: input.credential.kind === "service_token" ? input.credential.tokenId : null,
		source_ip: input.sourceIp,
	};
}

/**
 * Inserts the mint's audit row inside `tx`, the transaction that performs the act it records. A
 * request is `CREATED` and a delivery `STATUS_CHANGED`; `component_type` is `kubeconfig_mint` and
 * `component_id` the mint request's id.
 */
export async function writeMintAudit(tx: Tx, input: MintAuditInput): Promise<void> {
	await tx.insert(auditLog).values({
		project_id: input.projectId,
		user_id: input.actorUserId,
		action:
			input.event === "kubeconfig_mint.requested" ? "CREATED" : "STATUS_CHANGED",
		component_type: "kubeconfig_mint",
		component_id: input.mintId,
		changes: mintAuditChanges(input),
	});
}
