// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { trustedClientIp } from "@/lib/auth/trusted-ip";
import { authorizeCli } from "@/lib/authz/guard";
import { UsageLimitError } from "@/lib/billing/usage-guard";
import { cliJson } from "@/lib/cli/respond";
import { KUBECONFIG_MINT_SHARED_CLUSTER_REASON } from "@/lib/clusters/mint-eligibility";
import { errorName } from "@/lib/errors";
import { actionForTier } from "@/lib/kubeconfig-mint/clouds";
import { MINT_RATE_WINDOW_MS, takeMintRateLimit } from "@/lib/kubeconfig-mint/gates";
import { mintError, noStore, readBoundedJson } from "@/lib/kubeconfig-mint/http";

import {
	type MintRequestRefusal,
	requestKubeconfigMint,
} from "@/lib/kubeconfig-mint/request";
import { log } from "@/lib/observability/log";
import {
	cliKubeconfigMintRequest,
	cliKubeconfigMintResponse,
} from "@/lib/validations/cli-contract";

/** The largest request body read. A valid one is under 200 bytes; this is read before authentication. */
const MAX_BODY_BYTES = 4096;

const mlog = log.child({ component: "kubeconfig-mint" });

/** The HTTP status and message for each reason a mint was not queued. */
function refusalResponse(refusal: MintRequestRefusal): Response {
	switch (refusal) {
		case "not-found":
			return mintError(404, "Cluster not found");
		case "not-provisioned":
			return mintError(409, "The cluster has not been provisioned, so there is nothing to mint a kubeconfig for");
		case "unsupported-cloud":
			return mintError(422, "This cluster's cloud cannot mint a kubeconfig through Alethia");
		case "static-only":
			return mintError(422, 'This cloud issues certificates, so it can only mint a static kubeconfig: use shape "static"');
		case "shared-cluster":
			// The runner's own sentence, byte for byte: the CLI prints one message for this whichever
			// side refused it.
			return mintError(422, KUBECONFIG_MINT_SHARED_CLUSTER_REASON);
	}
}

/**
 * Requests a short-lived kubeconfig for one cluster (#5281) — step 1 of the mint channel drawn in
 * lib/validations/cli-contract.ts. The backing route for `alethia cluster kubeconfig`.
 *
 * Order, and why it is this order:
 *   1. The body (at most 4 KiB) is parsed, with no other I/O, only to learn the requested tier.
 *   2. The CLI actor is authenticated and EXACTLY that tier's action is enforced —
 *      `cluster:access_readonly` or `cluster:access_admin`, never "either" — before any other work.
 *      An unparseable body is checked against the lesser action and then refused, so an
 *      unauthenticated caller learns nothing about the body from the answer.
 *   3. The caller is rate-limited.
 *   4. lib/kubeconfig-mint/request.ts resolves the cluster inside the actor's org (another org's
 *      cluster is a 404), refuses a namespace/vcluster environment (422) before any job exists, and writes the job, the request row and the audit row in one transaction.
 *
 * Answers 202 with the queued mint; the client then polls `GET …/kubeconfig/:mintId`. Every response
 * is `Cache-Control: no-store`. The body carries only the client's PUBLIC key; nothing secret is
 * read, logged or returned here.
 */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
): Promise<Response> {
	const { id } = await params;

	const raw = await readBoundedJson(req, MAX_BODY_BYTES);
	const parsed = cliKubeconfigMintRequest.safeParse(raw);
	const action = parsed.success ? actionForTier(parsed.data.tier) : "access_readonly";

	const auth = await authorizeCli(req, action, { type: "cluster", id });
	if ("error" in auth) return noStore(auth.error);
	const { actor, credential } = auth;

	if (!parsed.success) {
		// The issue paths only — never the values, though the only value here is a public key.
		const fields = parsed.error.issues.map((i) => i.path.join(".") || "(body)");
		return mintError(400, `Invalid kubeconfig mint request: ${[...new Set(fields)].join(", ")}`);
	}
	// A malformed id cannot name a cluster; answering 404 here keeps it out of a uuid cast below.
	if (!z.uuid().safeParse(id).success) return mintError(404, "Cluster not found");

	// The budget is shared with the console's download (lib/kubeconfig-mint/gates.ts).
	if (!takeMintRateLimit(actor)) {
		const res = mintError(429, "Too many kubeconfig mint requests; try again in a few minutes");
		res.headers.set("Retry-After", String(Math.ceil(MINT_RATE_WINDOW_MS / 1000)));
		return res;
	}

	try {
		const outcome = await requestKubeconfigMint({
			actor,
			clusterId: id,
			request: parsed.data,
			client: "cli",
			credentialKind: credential,
			sourceIp: trustedClientIp(req.headers),
		});
		if (!outcome.ok) return refusalResponse(outcome.refusal);
		return noStore(
			cliJson(cliKubeconfigMintResponse, { mint: outcome.mint }, { status: 202 }),
		);
	} catch (err: unknown) {
		if (err instanceof UsageLimitError) return mintError(402, err.message);
		// The error's NAME only: a driver error's message can quote the statement and its parameters.
		mlog.error("kubeconfig mint request failed", { cluster_id: id, err_name: errorName(err) });
		return mintError(500, "Internal Server Error");
	}
}
