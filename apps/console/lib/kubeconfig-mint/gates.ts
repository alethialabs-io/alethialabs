// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The two gates every surface that mints a kubeconfig shares: the CLI routes
// (app/api/cli/clusters/[id]/kubeconfig/**) and the console's download action
// (app/server/actions/kubeconfig-download.ts, #5285). One definition, so a person cannot double their
// mint budget by alternating surfaces, and the poll's tier re-check cannot differ between them.

import { getPdp } from "@/lib/authz";
import { type Actor, ForbiddenError } from "@/lib/authz/types";
import type { KubeconfigMintTier } from "@/lib/db/schema/enums";
import { checkRateLimit } from "@/lib/rate-limit";
import { actionForTier } from "./clouds";

/** Mint requests one person may make in {@link MINT_RATE_WINDOW_MS}, per org, across every surface.
 *  An exec-credential kubeconfig re-mints once per TTL (15 min at the shortest), so honest use is a
 *  handful per hour; this bounds a loop, not a person. */
const MINT_RATE_LIMIT = 20;
/** The sliding window {@link MINT_RATE_LIMIT} is counted over. */
export const MINT_RATE_WINDOW_MS = 10 * 60_000;

/** Counts one mint request against the actor's budget. False when over it (the caller answers 429). */
export function takeMintRateLimit(actor: { orgId: string; userId: string }): boolean {
	return checkRateLimit(
		`kubeconfig-mint:${actor.orgId}:${actor.userId}`,
		MINT_RATE_LIMIT,
		MINT_RATE_WINDOW_MS,
	).ok;
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
