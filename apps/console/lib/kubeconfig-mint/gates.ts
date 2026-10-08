// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The two gates every surface that mints a kubeconfig shares: the CLI routes
// (app/api/cli/clusters/[id]/kubeconfig/**) and the console's download action
// (app/server/actions/kubeconfig-download.ts, #5285). One definition, so a person cannot double their
// mint budget by alternating surfaces, and the poll's tier re-check (collectGate) cannot differ between them. Also the
// credential a mint binds to, and which credentials may ask for which tier (#5310).

import { getPdp } from "@/lib/authz";
import type { CliAuthorization } from "@/lib/authz/guard";
import { type Actor, ForbiddenError, type ResourceRef } from "@/lib/authz/types";
import type { KubeconfigMintTier } from "@/lib/db/schema/enums";
import { checkRateLimit } from "@/lib/rate-limit";
import type { MintCredential } from "./audit";
import { actionForTier } from "./clouds";

/** Mint requests one person may make in {@link MINT_RATE_WINDOW_MS}, per org, across every surface.
 *  An exec-credential kubeconfig re-mints once per TTL (15 min at the shortest), so honest use is a
 *  handful per hour; this bounds a loop, not a person. */
const MINT_RATE_LIMIT = 20;
/** The fixed window {@link MINT_RATE_LIMIT} is counted over (lib/rate-limit.ts: shared by every replica). */
export const MINT_RATE_WINDOW_MS = 10 * 60_000;

/**
 * Counts one mint request against the actor's budget. False when over it (the caller answers 429) —
 * and also when the shared bucket store cannot answer: a mint hands out a cluster credential, so the
 * limiter fails CLOSED here, never open.
 */
export async function takeMintRateLimit(actor: { orgId: string; userId: string }): Promise<boolean> {
	const result = await checkRateLimit(
		`kubeconfig-mint:${actor.orgId}:${actor.userId}`,
		MINT_RATE_LIMIT,
		MINT_RATE_WINDOW_MS,
		{ failOpen: false },
	);
	return result.ok;
}

/**
 * The poll's tier re-check, in its two strengths (#5667). A read-only mint needs
 * `cluster:access_readonly`, which every caller has already checked before it polls, so both answer
 * true for it without asking again. An ADMIN mint is re-checked against `cluster:access_admin`, so
 * somebody demoted after asking does not collect the admin credential.
 *
 * WHICH ONE, AND WHY THERE ARE TWO. `enforce` RECORDS: it goes through the PDP's `enforce` →
 * `enforceDecision`, which writes an `authz_activity_log` row for every allow of a non-read action
 * (and `access_admin` is not a read) and for every denial, and emits the action event. Both clients
 * poll every two seconds, so asking that on every poll wrote an "accessed admin" row per poll while
 * the mint was still pending — rows that record waiting, not access. So:
 *
 * - `probe` asks `can()`, which records nothing. lib/kubeconfig-mint/poll.ts uses it while there is
 *   nothing to hand over (pending, failed, expired): it still refuses a demoted person early, but it
 *   authorizes nothing, because no credential leaves on those paths.
 * - `enforce` is the recording check. The poll calls it ONLY when it is about to hand over a `ready`
 *   admin credential, immediately before the consuming DELETE — a fresh PDP decision at that moment,
 *   never a remembered answer from an earlier probe. So the activity log gets one row per hand-over
 *   (or per refusal at hand-over), which is the event an `access_admin` alert rule is about.
 *
 * Which strength applies is poll.ts's decision, not the caller's: both callers (the CLI route and the
 * console action) pass the gate whole, so they cannot disagree about when a hand-over is recorded.
 */
export interface CollectGate {
	/** Non-recording: whether `tier` may be collected, for a poll that hands nothing over. */
	probe(tier: KubeconfigMintTier): Promise<boolean>;
	/** Recording and enforcing: whether `tier` may be handed over NOW. Call only at the hand-over. */
	enforce(tier: KubeconfigMintTier): Promise<boolean>;
}

/** The {@link CollectGate} for `actor` collecting a mint on `clusterId`. */
export function collectGate(actor: Actor, clusterId: string): CollectGate {
	const resource: ResourceRef = { type: "cluster", id: clusterId };
	return {
		async probe(tier) {
			if (tier === "readonly") return true;
			const decision = await getPdp().can(actor, actionForTier(tier), resource);
			return decision.allowed;
		},
		async enforce(tier) {
			if (tier === "readonly") return true;
			try {
				await getPdp().enforce(actor, actionForTier(tier), resource);
				return true;
			} catch (e) {
				if (e instanceof ForbiddenError) return false;
				throw e;
			}
		},
	};
}

/**
 * The credential a CLI mint binds to, from what `authorizeCli` resolved: the token's own id for a
 * service token, and the person for a session. Only that same credential may then collect the mint.
 */
export function mintCredentialOf(auth: CliAuthorization): MintCredential {
	switch (auth.credential) {
		case "service_token":
			return { kind: "service_token", tokenId: auth.serviceTokenId };
		case "session":
			return { kind: "session" };
	}
}

/**
 * Whether `credential` may REQUEST a mint of `tier` at all (#5310). A service token may mint a
 * read-only kubeconfig — CI and automation need kubectl — but never an admin one: an admin cluster
 * credential handed to unattended automation is the riskier policy, so admin is for people. This is
 * the policy; the database restates it as a CHECK on kubeconfig_mint_requests, so a writer that
 * skipped this function still cannot store an admin mint bound to a token.
 */
export function credentialMayMintTier(
	credential: MintCredential,
	tier: KubeconfigMintTier,
): boolean {
	switch (credential.kind) {
		case "session":
			return true;
		case "service_token":
			return tier === "readonly";
	}
}
