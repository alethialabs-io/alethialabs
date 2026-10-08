// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { trustedClientIp } from "@/lib/auth/trusted-ip";
import { authorizeCliQuiet } from "@/lib/authz/guard";
import { cliJson } from "@/lib/cli/respond";
import { errorName } from "@/lib/errors";
import { collectGate, mintCredentialOf } from "@/lib/kubeconfig-mint/gates";
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
 *   needs at least that), asked on EVERY poll — and recorded on none (#5670). The poll is waiting,
 *   not access: `authorizeCliQuiet` makes exactly `authorizeCli`'s decision with `can()`, so a
 *   caller without the permission is still a 403 on every poll, but a download no longer writes one
 *   `access_readonly` row per poll interval. The mint is on the record once, where it was asked for:
 *   the POST that started it (`../route.ts`) goes through the recording `authorizeCli`. The console
 *   poll (`pollKubeconfigDownload`) is the same split, with `authorizeQuiet`. An ADMIN mint is re-checked against `cluster:access_admin` before
 *   anything is answered: somebody demoted after asking does not collect the admin credential. That
 *   re-check records an activity row only at the hand-over of a `ready` mint, where it is a fresh,
 *   enforcing decision; while the mint is pending it is a non-recording probe (#5667,
 *   lib/kubeconfig-mint/gates.ts `collectGate`).
 * - **Whose.** Only the CREDENTIAL that requested the mint, in the org it was requested in, sees it:
 *   the same service token (by its id), or the same person's session (#5310). The person is enforced
 *   by the row's RLS policy and the query; the credential by the query (lib/kubeconfig-mint/poll.ts).
 *   Anybody else's mint, another of the same person's tokens' mint, another cluster's, and one
 *   already collected are all the same 404.
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

	const auth = await authorizeCliQuiet(req, "access_readonly", { type: "cluster", id });
	if ("error" in auth) return noStore(auth.error);
	const { actor } = auth;

	if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(mintId).success) {
		return mintError(404, "Kubeconfig mint not found");
	}

	try {
		const outcome = await pollKubeconfigMint({
			actor,
			clusterId: id,
			mintId,
			client: "cli",
			credential: mintCredentialOf(auth),
			sourceIp: trustedClientIp(req.headers),
			gate: collectGate(actor, id),
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
