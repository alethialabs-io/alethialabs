// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The download, end to end, in the browser (#5285):
//
//   1. generate an ephemeral X25519 key (private half non-extractable);
//   2. ask for a read-only, static, 1h mint, sending only the PUBLIC key;
//   3. poll until the mint is ready, failed or expired (or the poll window closes);
//   4. open the seal locally, check it is a static read-only kubeconfig, save it as a file;
//   5. drop the key and the plaintext.
//
// Every dependency with a side effect — the two server actions, the clock, the save — is passed in, so
// the whole flow runs under test against a mocked poll. Nothing here logs: the plaintext and the key
// never reach `console.*` or any logger, and tests/components/clusters/kubeconfig-download/flow.test.ts
// spies on both to hold that.
//
// "Drop from memory" in a browser means: zero every byte array that held key-derived material or
// plaintext (hpke.ts and credential.ts do), revoke the object URL, and keep no reference to the key or
// the kubeconfig string once the file is handed over, so both are collectable. A JS string cannot be
// zeroed; holding no reference to it is the most a page can do.

import type {
	KubeconfigDownloadPoll,
	KubeconfigDownloadRefusal,
	KubeconfigDownloadRequest,
} from "@/app/server/actions/kubeconfig-download";
import { type OpenedKubeconfig, readOpenedCredential } from "./credential";
import { type RecipientKey, generateRecipientKey, openSealed, toBase64Url } from "./hpke";

/** How often the card polls while the runner mints. */
export const POLL_INTERVAL_MS = 2000;

/** How the download ended. */
export type DownloadOutcome =
	| { kind: "saved"; fileName: string; expiresAt: string; privateEndpoint: boolean }
	| { kind: "unsupported" }
	| { kind: "refused"; status: KubeconfigDownloadRefusal; message?: string }
	| { kind: "failed"; reason: string; privateEndpoint: boolean }
	| { kind: "expired"; privateEndpoint: boolean }
	| { kind: "unreadable"; privateEndpoint: boolean }
	| { kind: "lost" }
	| { kind: "cancelled" };

/** Everything the flow touches outside itself. */
export interface DownloadDeps {
	clusterId: string;
	fileName: string;
	request: (input: { clusterId: string; clientPublicKey: string }) => Promise<KubeconfigDownloadRequest>;
	poll: (input: { clusterId: string; mintId: string }) => Promise<KubeconfigDownloadPoll>;
	/** Hands the kubeconfig to the person as a file. */
	save: (fileName: string, contents: string) => void;
	/** Defaults to WebCrypto X25519; a test injects a known key. */
	generateKey?: () => Promise<RecipientKey>;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	signal?: AbortSignal;
	/** Called on each poll that reports the endpoint, so the card can show the notice while it waits. */
	onPrivateEndpoint?: (privateEndpoint: boolean) => void;
}

/** Resolves after `ms`. */
function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs one download. Never throws for an expected outcome; a thrown error is a bug or a network
 * failure of the action call itself, which the card reports generically.
 */
export async function runKubeconfigDownload(deps: DownloadDeps): Promise<DownloadOutcome> {
	const sleep = deps.sleep ?? defaultSleep;
	const now = deps.now ?? Date.now;
	// The key is local to this call: nothing outside it holds a reference, so it is collectable the
	// moment the call returns, whatever the outcome.
	let key: RecipientKey;
	try {
		key = await (deps.generateKey ?? generateRecipientKey)();
	} catch {
		return { kind: "unsupported" };
	}

	const queued = await deps.request({
		clusterId: deps.clusterId,
		clientPublicKey: toBase64Url(key.publicKey),
	});
	if (!queued.ok) return { kind: "refused", status: queued.status, message: queued.message };

	const deadline = Date.parse(queued.pollExpiresAt);
	let privateEndpoint = false;
	for (;;) {
		if (deps.signal?.aborted) return { kind: "cancelled" };
		const res = await deps.poll({ clusterId: deps.clusterId, mintId: queued.mintId });
		if (!res.ok) return res.status === 404 ? { kind: "lost" } : { kind: "refused", status: res.status };
		const p = res.poll;
		if (p.private_endpoint !== null) {
			privateEndpoint = p.private_endpoint;
			deps.onPrivateEndpoint?.(privateEndpoint);
		}
		switch (p.status) {
			case "failed":
				return { kind: "failed", reason: p.reason, privateEndpoint };
			case "expired":
				return { kind: "expired", privateEndpoint };
			case "ready": {
				let opened: OpenedKubeconfig | null;
				try {
					opened = readOpenedCredential(await openSealed(key, p.sealed, queued.mintId, deps.clusterId));
				} catch {
					opened = null;
				}
				if (!opened) return { kind: "unreadable", privateEndpoint };
				deps.save(deps.fileName, opened.kubeconfig);
				return { kind: "saved", fileName: deps.fileName, expiresAt: opened.expiresAt, privateEndpoint };
			}
			case "pending":
				break;
		}
		if (Number.isFinite(deadline) && now() >= deadline) return { kind: "expired", privateEndpoint };
		await sleep(POLL_INTERVAL_MS);
	}
}

/** Saves `contents` as a file through a short-lived Blob URL. The URL is revoked on the next task
 *  rather than synchronously after the click, which some browsers read as cancelling the download. */
export function saveAsFile(fileName: string, contents: string): void {
	const url = URL.createObjectURL(new Blob([contents], { type: "application/yaml" }));
	try {
		const a = document.createElement("a");
		a.href = url;
		a.download = fileName;
		a.rel = "noopener";
		a.style.display = "none";
		document.body.appendChild(a);
		a.click();
		a.remove();
	} finally {
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}
}

/** What the card says for an outcome that is not a saved file, in the CLI's terms where they overlap. */
export function outcomeMessage(outcome: Exclude<DownloadOutcome, { kind: "saved" } | { kind: "cancelled" }>): string {
	switch (outcome.kind) {
		case "unsupported":
			return "This browser cannot create the X25519 key the download is sealed to. Use the CLI instead: alethia cluster kubeconfig.";
		case "failed":
			return outcome.reason;
		case "expired":
			return "The runner did not finish the kubeconfig in time. Try again.";
		case "unreadable":
			return "The kubeconfig arrived but could not be opened in this browser. Nothing was saved. Try again.";
		case "lost":
			return "The kubeconfig request is no longer available. Try again.";
		case "refused":
			return refusalMessage(outcome.status, outcome.message);
	}
}

/** The message for each refusal status. 402 carries the billing guard's own sentence when it has one. */
function refusalMessage(status: KubeconfigDownloadRefusal, message?: string): string {
	switch (status) {
		case 402:
			return message ?? "Your plan's usage limit is reached, so no new kubeconfig can be minted.";
		case 403:
			return "You need cluster read-only access to download a kubeconfig.";
		case 404:
			return "This cluster was not found.";
		case 409:
			return "This cluster has not finished provisioning, so there is no kubeconfig to mint yet.";
		case 422:
			return "This cluster's cloud cannot mint a kubeconfig through Alethia.";
		case 429:
			return "Too many kubeconfig requests. Try again in a few minutes.";
		case 400:
		case 500:
			return "The kubeconfig could not be requested. Try again.";
	}
}
