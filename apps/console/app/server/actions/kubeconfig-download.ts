"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The console's half of "Download kubeconfig (1h, read-only)" on the cluster card (#5285).
//
// The CLI reaches the mint through `POST/GET /api/cli/clusters/:id/kubeconfig[/:mintId]`, which
// authenticate a CLI bearer token. The console calls its own server the way every card does — through
// server actions on the session — and these are thin seats over the SAME library the routes use
// (lib/kubeconfig-mint/request.ts, poll.ts, gates.ts): the same tier check, the same rate-limit budget,
// the same write-before audit (with `client: "console"`), the same read-once collection.
//
// What this file never sees: the private key or the plaintext. The browser generates the key and
// sends only the PUBLIC half; what comes back is ciphertext the console cannot open.
//
// AI TOOL DENYLIST. This module is listed in lib/ai/tools/registry.ts AI_TOOL_DENIED_MODULES, so no
// agent tool can reach it (#5250 §5 "ReBAC"). That is also why it is its own file rather than a pair of
// exports in clusters.ts: `getClusters` there is an agent tool's data source.

import { headers } from "next/headers";
import { z } from "zod";
import { trustedClientIp } from "@/lib/auth/trusted-ip";
import { getPdp } from "@/lib/authz";
import { authorize, authorizeQuiet, currentActor } from "@/lib/authz/guard";
import { type Actor, ForbiddenError } from "@/lib/authz/types";
import { UsageLimitError } from "@/lib/billing/usage-guard";
import { KUBECONFIG_MINT_SHARED_CLUSTER_REASON } from "@/lib/clusters/mint-eligibility";
import { errorName } from "@/lib/errors";
import { mayCollectTier, takeMintRateLimit } from "@/lib/kubeconfig-mint/gates";
import { pollKubeconfigMint } from "@/lib/kubeconfig-mint/poll";
import { type MintRequestRefusal, requestKubeconfigMint } from "@/lib/kubeconfig-mint/request";
import { log } from "@/lib/observability/log";
import {
	type CliKubeconfigMintPollResponse,
	cliKubeconfigMintRequest,
	kubeconfigMintPublicKey,
} from "@/lib/validations/cli-contract";

const mlog = log.child({ component: "kubeconfig-download" });

/** The one mint the card asks for: a static kubeconfig, read-only, valid for an hour (decision 4). */
const CONSOLE_MINT: { tier: "readonly"; shape: "static"; ttl_seconds: number } = {
	tier: "readonly",
	shape: "static",
	ttl_seconds: 3600,
};

/** Why the console's mint request was not queued, as the HTTP status the CLI route answers for the
 *  same case — so the card and `alethia cluster kubeconfig` say the same thing about the same refusal. */
export type KubeconfigDownloadRefusal = 400 | 402 | 403 | 404 | 409 | 422 | 429 | 500;

/** The outcome of {@link requestKubeconfigDownload}. */
export type KubeconfigDownloadRequest =
	| { ok: true; mintId: string; pollExpiresAt: string }
	| { ok: false; status: KubeconfigDownloadRefusal; message?: string };

/** The outcome of {@link pollKubeconfigDownload}: the contract's poll body, or why there is none. */
export type KubeconfigDownloadPoll =
	| { ok: true; poll: CliKubeconfigMintPollResponse }
	| { ok: false; status: 400 | 403 | 404 | 500 };

const requestInput = z.object({ clusterId: z.uuid(), clientPublicKey: kubeconfigMintPublicKey });
const pollInput = z.object({ clusterId: z.uuid(), mintId: z.uuid() });

/** The status the CLI route answers for each refusal from lib/kubeconfig-mint/request.ts. */
function refusalStatus(refusal: MintRequestRefusal): KubeconfigDownloadRefusal {
	switch (refusal) {
		case "not-found":
			return 404;
		case "not-provisioned":
			return 409;
		case "unsupported-cloud":
		case "static-only":
		case "shared-cluster":
			return 422;
	}
}

/** The caller's IP from the deployment's trusted proxy header, for the audit row. */
async function sourceIp(): Promise<string | null> {
	return trustedClientIp(new Headers(await headers()));
}

/**
 * Whether the caller may download a read-only kubeconfig for `clusterId` — `cluster:access_readonly`,
 * the action the request itself enforces. The card renders the button only on true. Non-throwing and
 * fail-closed: any error is false. This is a display decision; the request re-checks.
 */
export async function canDownloadKubeconfig(clusterId: string): Promise<boolean> {
	const id = z.uuid().safeParse(clusterId);
	if (!id.success) return false;
	try {
		const actor = await currentActor();
		const decision = await getPdp().can(actor, "access_readonly", { type: "cluster", id: id.data });
		return decision.allowed;
	} catch {
		return false;
	}
}

/**
 * Queues one read-only, static, 1h kubeconfig mint for `clusterId`, sealed to `clientPublicKey` (the
 * browser's ephemeral X25519 public key, base64url). Enforces `cluster:access_readonly` first, then
 * the shared rate limit, then the library's tenancy, provisioning, cloud and billing checks. The job,
 * the request row and the audit row (`client: "console"`) commit together.
 */
export async function requestKubeconfigDownload(input: {
	clusterId: string;
	clientPublicKey: string;
}): Promise<KubeconfigDownloadRequest> {
	const parsed = requestInput.safeParse(input);
	if (!parsed.success) return { ok: false, status: 400 };
	const { clusterId, clientPublicKey } = parsed.data;

	let actor: Actor;
	try {
		actor = await authorize("access_readonly", { type: "cluster", id: clusterId });
	} catch (e) {
		if (e instanceof ForbiddenError) return { ok: false, status: 403 };
		throw e;
	}

	if (!takeMintRateLimit(actor)) return { ok: false, status: 429 };

	try {
		const outcome = await requestKubeconfigMint({
			actor,
			clusterId,
			request: cliKubeconfigMintRequest.parse({ ...CONSOLE_MINT, client_public_key: clientPublicKey }),
			client: "console",
			credentialKind: "session",
			sourceIp: await sourceIp(),
		});
		if (!outcome.ok) {
			return outcome.refusal === "shared-cluster"
				? { ok: false, status: 422, message: KUBECONFIG_MINT_SHARED_CLUSTER_REASON }
				: { ok: false, status: refusalStatus(outcome.refusal) };
		}
		return {
			ok: true,
			mintId: outcome.mint.id,
			pollExpiresAt: outcome.mint.expires_at.toISOString(),
		};
	} catch (err: unknown) {
		if (err instanceof UsageLimitError) return { ok: false, status: 402, message: err.message };
		// The error's NAME only: a driver error's message can quote the statement and its parameters.
		mlog.error("kubeconfig download request failed", { cluster_id: clusterId, err_name: errorName(err) });
		return { ok: false, status: 500 };
	}
}

/**
 * Polls one mint the caller requested. `ready` is served once — the row is deleted by the read, with
 * its delivery audit row — and carries ciphertext only. Another person's mint, another cluster's, and
 * one already collected are all 404. Uses the quiet PDP check: a poll every two seconds is not an
 * activity-feed event, and the request already recorded one.
 */
export async function pollKubeconfigDownload(input: {
	clusterId: string;
	mintId: string;
}): Promise<KubeconfigDownloadPoll> {
	const parsed = pollInput.safeParse(input);
	if (!parsed.success) return { ok: false, status: 400 };
	const { clusterId, mintId } = parsed.data;

	let actor: Actor;
	try {
		actor = await authorizeQuiet("access_readonly", { type: "cluster", id: clusterId });
	} catch (e) {
		if (e instanceof ForbiddenError) return { ok: false, status: 403 };
		throw e;
	}

	try {
		const outcome = await pollKubeconfigMint({
			actor,
			clusterId,
			mintId,
			client: "console",
			credentialKind: "session",
			sourceIp: await sourceIp(),
			mayCollect: (tier) => mayCollectTier(actor, clusterId, tier),
		});
		if (!outcome.ok) return { ok: false, status: outcome.refusal === "forbidden" ? 403 : 404 };
		return { ok: true, poll: outcome.body };
	} catch (err: unknown) {
		mlog.error("kubeconfig download poll failed", {
			cluster_id: clusterId,
			mint_id: mintId,
			err_name: errorName(err),
		});
		return { ok: false, status: 500 };
	}
}
