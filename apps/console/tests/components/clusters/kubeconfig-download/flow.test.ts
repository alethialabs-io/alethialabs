// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The browser download flow (#5285) against a mocked request and poll. The `ready` case is REAL
// cryptography: the poll serves the blob Go's kubeaccess.Seal produced (seal_vectors.json
// alethia_mint), the flow opens it with that vector's recipient key, and the saved file must be the
// kubeconfig inside it. Every test also asserts nothing reached `console.*` carrying the plaintext.

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	KubeconfigDownloadPoll,
	KubeconfigDownloadRequest,
} from "@/app/server/actions/kubeconfig-download";
import {
	type DownloadDeps,
	type DownloadOutcome,
	POLL_INTERVAL_MS,
	outcomeMessage,
	runKubeconfigDownload,
} from "@/components/clusters/kubeconfig-download/flow";
import {
	type RecipientKey,
	fromBase64Url,
	generateRecipientKey,
	toBase64Url,
} from "@/components/clusters/kubeconfig-download/hpke";

const V: {
	recipient_sk_hex: string;
	recipient_pk_b64url: string;
	mint_id: string;
	cluster_id: string;
	sealed_b64url: string;
	plaintext: string;
} = JSON.parse(
	readFileSync(
		path.resolve(__dirname, "../../../../../../packages/core/kubeaccess/testdata/seal_vectors.json"),
		"utf8",
	),
).alethia_mint;

const KUBECONFIG = "apiVersion: v1\nkind: Config\n";
const FILE = "alethia-shop-dev.kubeconfig";

/** The vector's recipient key, imported (non-extractable) the only way a test can: JWK. */
async function vectorKey(): Promise<RecipientKey> {
	const sk = Uint8Array.from(V.recipient_sk_hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
	const pk = fromBase64Url(V.recipient_pk_b64url);
	const privateKey = await crypto.subtle.importKey(
		"jwk",
		{ kty: "OKP", crv: "X25519", d: toBase64Url(sk), x: toBase64Url(pk) },
		{ name: "X25519" },
		false,
		["deriveBits"],
	);
	return { privateKey, publicKey: pk };
}

const QUEUED: KubeconfigDownloadRequest = {
	ok: true,
	mintId: V.mint_id,
	pollExpiresAt: "2099-01-01T00:00:00.000Z",
};

const PENDING: KubeconfigDownloadPoll = {
	ok: true,
	poll: { status: "pending", private_endpoint: null, expires_at: "2099-01-01T00:00:00.000Z" },
};
const READY = (privateEndpoint = false): KubeconfigDownloadPoll => ({
	ok: true,
	poll: { status: "ready", private_endpoint: privateEndpoint, sealed: V.sealed_b64url },
});

/** Builds deps around a scripted sequence of poll answers. */
function deps(polls: KubeconfigDownloadPoll[], over: Partial<DownloadDeps> = {}) {
	const save = vi.fn<(name: string, contents: string) => void>();
	const request = vi.fn(async () => QUEUED);
	const queue = [...polls];
	const poll = vi.fn(async () => {
		const next = queue.shift();
		if (!next) throw new Error("poll called more times than scripted");
		return next;
	});
	const sleep = vi.fn(async () => {});
	const d: DownloadDeps = {
		clusterId: V.cluster_id,
		fileName: FILE,
		request,
		poll,
		save,
		sleep,
		generateKey: vectorKey,
		...over,
	};
	return { d, save, request, poll, sleep };
}

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
	consoleSpies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((m) =>
		vi.spyOn(console, m).mockImplementation(() => {}),
	);
});
afterEach(() => {
	// No logger ever sees the plaintext, the kubeconfig or the ciphertext.
	// A throw in afterEach fails the test it follows.
	const seen = JSON.stringify(consoleSpies.flatMap((s) => s.mock.calls));
	for (const s of consoleSpies) s.mockRestore();
	if (seen.includes("apiVersion") || seen.includes(V.sealed_b64url.slice(0, 24))) {
		throw new Error("the kubeconfig or its ciphertext reached console.*");
	}
});

describe("runKubeconfigDownload", () => {
	it("pending → ready: opens the Go-sealed blob locally and saves the kubeconfig inside it", async () => {
		const { d, save, request, poll, sleep } = deps([PENDING, PENDING, READY()]);
		const out = await runKubeconfigDownload(d);
		expect(out).toEqual({
			kind: "saved",
			fileName: FILE,
			expiresAt: "2026-10-01T13:00:00Z",
			privateEndpoint: false,
		});
		expect(save).toHaveBeenCalledExactlyOnceWith(FILE, KUBECONFIG);
		// Only the PUBLIC key left the browser.
		expect(request).toHaveBeenCalledExactlyOnceWith({
			clusterId: V.cluster_id,
			clientPublicKey: V.recipient_pk_b64url,
		});
		expect(poll).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(POLL_INTERVAL_MS);
	});

	it("reports the private endpoint as soon as a poll knows it, and on the outcome", async () => {
		const onPrivateEndpoint = vi.fn();
		const { d } = deps([READY(true)], { onPrivateEndpoint });
		const out = await runKubeconfigDownload(d);
		expect(out).toMatchObject({ kind: "saved", privateEndpoint: true });
		expect(onPrivateEndpoint).toHaveBeenCalledWith(true);
	});

	it("failed: stops polling, saves nothing, and carries the runner's fixed reason", async () => {
		const reason = "The runner could not reach the cluster's API endpoint.";
		const { d, save, poll } = deps([
			PENDING,
			{ ok: true, poll: { status: "failed", private_endpoint: true, reason } },
		]);
		const out = await runKubeconfigDownload(d);
		expect(out).toEqual({ kind: "failed", reason, privateEndpoint: true });
		expect(save).not.toHaveBeenCalled();
		expect(poll).toHaveBeenCalledTimes(2);
	});

	it("expired (said by the server): stops and saves nothing", async () => {
		const { d, save } = deps([{ ok: true, poll: { status: "expired", private_endpoint: null } }]);
		expect(await runKubeconfigDownload(d)).toEqual({ kind: "expired", privateEndpoint: false });
		expect(save).not.toHaveBeenCalled();
	});

	it("expired (the poll window closed on the client's clock): stops rather than polling forever", async () => {
		const { d, poll } = deps([PENDING, PENDING, PENDING], {
			request: async () => ({ ...QUEUED, pollExpiresAt: "2026-01-01T00:00:10.000Z" }),
			now: (() => {
				let t = Date.parse("2026-01-01T00:00:00.000Z");
				return () => (t += 6000);
			})(),
		});
		expect(await runKubeconfigDownload(d)).toEqual({ kind: "expired", privateEndpoint: false });
		expect(poll).toHaveBeenCalledTimes(2);
	});

	it("a blob sealed to another key is unreadable, and nothing is saved", async () => {
		const { d, save } = deps([READY()], { generateKey: generateRecipientKey });
		expect(await runKubeconfigDownload(d)).toEqual({ kind: "unreadable", privateEndpoint: false });
		expect(save).not.toHaveBeenCalled();
	});

	it("no X25519 in this browser: unsupported, and nothing is requested", async () => {
		const { d, request } = deps([], {
			generateKey: async () => {
				throw new DOMException("Unrecognized name", "NotSupportedError");
			},
		});
		expect(await runKubeconfigDownload(d)).toEqual({ kind: "unsupported" });
		expect(request).not.toHaveBeenCalled();
	});

	it.each([402, 409, 422, 429] as const)("a %d refusal stops before any poll", async (status) => {
		const { d, poll } = deps([], { request: async () => ({ ok: false, status }) });
		expect(await runKubeconfigDownload(d)).toEqual({ kind: "refused", status, message: undefined });
		expect(poll).not.toHaveBeenCalled();
	});

	it("a mint that vanished mid-poll (404) is lost, not a refusal", async () => {
		const { d } = deps([PENDING, { ok: false, status: 404 }]);
		expect(await runKubeconfigDownload(d)).toEqual({ kind: "lost" });
	});

	it("an aborted download stops polling", async () => {
		const ctl = new AbortController();
		const { d, poll } = deps([PENDING, PENDING], {
			signal: ctl.signal,
			sleep: async () => ctl.abort(),
		});
		expect(await runKubeconfigDownload(d)).toEqual({ kind: "cancelled" });
		expect(poll).toHaveBeenCalledTimes(1);
	});
});

describe("outcomeMessage", () => {
	it.each([
		[{ kind: "refused", status: 402 }, /usage limit/],
		[{ kind: "refused", status: 402, message: "Your plan allows 25 jobs a day." }, /25 jobs a day/],
		[{ kind: "refused", status: 409 }, /not finished provisioning/],
		[{ kind: "refused", status: 422 }, /cannot mint a kubeconfig/],
		[{ kind: "refused", status: 429 }, /Too many kubeconfig requests/],
		[{ kind: "refused", status: 403 }, /read-only access/],
		[{ kind: "unsupported" }, /alethia cluster kubeconfig/],
		[{ kind: "expired", privateEndpoint: false }, /did not finish/],
	] satisfies [Exclude<DownloadOutcome, { kind: "saved" } | { kind: "cancelled" }>, RegExp][])(
		"%o → %s",
		(outcome, re) => {
			expect(outcomeMessage(outcome)).toMatch(re);
		},
	);
});
