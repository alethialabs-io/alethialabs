// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { trustedClientIp } from "@/lib/auth/trusted-ip";
import { getPdp } from "@/lib/authz";
import { authorizeCli } from "@/lib/authz/guard";
import { ForbiddenError } from "@/lib/authz/types";
import { cliJson } from "@/lib/cli/respond";
import { errorName } from "@/lib/errors";
import { actionForTier } from "@/lib/kubeconfig-mint/clouds";
import { mintError, noStore } from "@/lib/kubeconfig-mint/http";
import { pollKubeconfigMint } from "@/lib/kubeconfig-mint/poll";
import { log } from "@/lib/observability/log";
import { cliKubeconfigMintPollResponse } from "@/lib/validations/cli-contract";

const mlog = log.child({ component: "kubeconfig-mint" });

/**
 * Polls one kubeconfig mint (#5281) — step 5 of the mint channel drawn in
 * lib/validations/cli-contract.ts. Answers `pending{expires_at}`, `ready{sealed}`, `failed{reason}`
 * or `expired`, each with `private_endpoint`.
 *
 * - **Who.** The CLI actor is authenticated and must hold `cluster:access_readonly` (every mint
 *   needs at least that). An ADMIN mint is re-checked against `cluster:access_admin` before
 *   anything is answered: somebody demoted after asking does not collect the admin credential.
 * - **Whose.** Only the actor who requested the mint, in the org they requested it in, sees it —
 *   enforced by the row's RLS policy and by the query (lib/kubeconfig-mint/poll.ts). Anybody
 *   else's mint, another cluster's, and one already collected are all the same 404.
 * - **Once.** `ready` is served by the statement that deletes the row, with the delivery audit row
 *   in the same transaction. The next poll is a 404.
 *
 * Every response is `Cache-Control: no-store`. The ciphertext is never logged.
 */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string; mintId: string }> },
): Promise<Response> {
	const { id, mintId } = await params;

	const auth = await authorizeCli(req, "access_readonly", { type: "cluster", id });
	if ("error" in auth) return noStore(auth.error);
	const { actor, credential } = auth;

	if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(mintId).success) {
		return mintError(404, "Kubeconfig mint not found");
	}

	try {
		const outcome = await pollKubeconfigMint({
			actor,
			clusterId: id,
			mintId,
			client: "cli",
			credentialKind: credential,
			sourceIp: trustedClientIp(req.headers),
			mayCollect: async (tier) => {
				if (tier === "readonly") return true; // checked above, by authorizeCli
				try {
					await getPdp().enforce(actor, actionForTier(tier), { type: "cluster", id });
					return true;
				} catch (e) {
					if (e instanceof ForbiddenError) return false;
					throw e;
				}
			},
		});
		if (!outcome.ok) {
			return outcome.refusal === "forbidden"
				? mintError(403, "Forbidden")
				: mintError(404, "Kubeconfig mint not found");
		}
		return noStore(cliJson(cliKubeconfigMintPollResponse, outcome.body));
	} catch (err: unknown) {
		mlog.error("kubeconfig mint poll failed", {
			cluster_id: id,
			mint_id: mintId,
			err_name: errorName(err),
		});
		return mintError(500, "Internal Server Error");
	}
}
