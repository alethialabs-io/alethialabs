// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The two gates every surface that mints a kubeconfig shares: the CLI routes
// (app/api/cli/clusters/[id]/kubeconfig/**) and the console's download action
// (app/server/actions/kubeconfig-download.ts, #5285). One definition, so a person cannot double their
// mint budget by alternating surfaces, and the poll's tier re-check cannot differ between them. Also the
// credential a mint binds to, and which credentials may ask for which tier (#5310).

import { getPdp } from "@/lib/authz";
import type { CliAuthorization } from "@/lib/authz/guard";
import { type Actor, ForbiddenError } from "@/lib/authz/types";
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
 * Whether `actor` may COLLECT a mint of `tier` on `clusterId` now — the poll's re-check. A read-only
 * mint needs `cluster:access_readonly`, which every caller has already been checked for before it
 * polls; an admin mint is re-checked against `cluster:access_admin`, so somebody demoted after asking
 * does not collect the admin credential.
 */
export async function mayCollectTier(
	actor: Actor,
	clusterId: string,
	tier: KubeconfigMintTier,
): Promise<boolean> {
	if (tier === "readonly") return true;
	try {
		await getPdp().enforce(actor, actionForTier(tier), { type: "cluster", id: clusterId });
		return true;
	} catch (e) {
		if (e instanceof ForbiddenError) return false;
		throw e;
	}
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
