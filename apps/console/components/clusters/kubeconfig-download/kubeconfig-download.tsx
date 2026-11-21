"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// "Download kubeconfig (1h, read-only)" — the cluster record's stage-2 access action (#5285, design
// #5250 decisions 4, 6, 7). It sits under the stage-1 command in the "Cluster access" block.
//
// Rendered only for a person holding `cluster:access_readonly` — the clusters read answers that per
// cluster (`can_download_kubeconfig`, lib/rpc/procedures/clusters.ts), so the button paints with the
// record and asks nothing of its own; the request re-checks. The key is generated, the seal opened
// and the file built in THIS browser; the console relays ciphertext it cannot open. See flow.ts for
// the sequence and hpke.ts for the construction.
//
// THE WAIT IS LIVE, BOUNDED AND CANCELLABLE. It reads the mint again when the org's change stream
// says a job moved (mint-wait.ts) — no timer loop; it ends when the request's window closes, which
// the control shows; and Cancel stops it at once. A wait that has gone on long enough for a healthy
// runner to have answered says so and points at the runners.

import { formatDate, formatRelative } from "@repo/format";
import { Button } from "@repo/ui/button";
import { Spinner } from "@repo/ui/spinner";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	pollKubeconfigDownload,
	requestKubeconfigDownload,
} from "@/app/server/actions/kubeconfig-download";
import { globalHref } from "@/lib/routing";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { kubeconfigFileName } from "./credential";
import { type DownloadOutcome, outcomeMessage, runKubeconfigDownload, saveAsFile } from "./flow";
import { x25519Supported } from "./hpke";
import { createMintWait, mintWaitKey } from "./mint-wait";

/** What the control shows. */
type DownloadState =
	| { phase: "idle" }
	| { phase: "working"; expiresAt: string | null; slow: boolean }
	| { phase: "done"; outcome: DownloadOutcome };

/** How long a wait runs before the control says a runner may not be picking it up. */
export const SLOW_AFTER_MS = 20_000;

/** The sentence decision 6 asks for: said plainly, not hidden behind an icon. */
const PRIVATE_ENDPOINT_NOTICE =
	"This cluster's API endpoint is private. The kubeconfig works only from a network that can reach it, such as over a VPN or through a bastion.";

/**
 * The download control for one cluster. Renders nothing unless `allowed` — the server's answer to
 * whether the viewer holds `cluster:access_readonly` on this cluster, carried by the clusters read.
 */
export function KubeconfigDownload({
	clusterId,
	projectName,
	environment,
	allowed,
}: {
	clusterId: string;
	projectName: string;
	environment: string;
	allowed: boolean;
}) {
	const orgSlug = useActiveOrgSlug();
	const queryClient = useQueryClient();
	const [state, setState] = useState<DownloadState>({ phase: "idle" });
	const [privateEndpoint, setPrivateEndpoint] = useState(false);
	const abort = useRef<AbortController | null>(null);
	const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// The wait's entry, kept mounted so the `jobs` topic's invalidation has something to mark. It has
	// no fetcher: reading a mint collects it, so the flow reads it, not Query (mint-wait.ts).
	const waitKey = useMemo(() => mintWaitKey(clusterId), [clusterId]);
	useQuery({ queryKey: waitKey, queryFn: skipToken });
	const wait = useMemo(() => createMintWait(queryClient, waitKey), [queryClient, waitKey]);

	/** Stops the one-shot "this is taking long" timer. */
	const clearSlowTimer = () => {
		if (slowTimer.current !== null) clearTimeout(slowTimer.current);
		slowTimer.current = null;
	};

	// Leaving the record stops the wait; the server's sweep expires the unread mint.
	useEffect(
		() => () => {
			abort.current?.abort();
			if (slowTimer.current !== null) clearTimeout(slowTimer.current);
		},
		[],
	);

	if (!allowed) return null;

	/** Runs one download and records how it ended. */
	async function start() {
		setState({ phase: "working", expiresAt: null, slow: false });
		setPrivateEndpoint(false);
		const controller = new AbortController();
		abort.current = controller;
		clearSlowTimer();
		// One timer, set once: it reads nothing, it only changes what the control says about the wait.
		slowTimer.current = setTimeout(() => {
			setState((current) => (current.phase === "working" ? { ...current, slow: true } : current));
		}, SLOW_AFTER_MS);
		let outcome: DownloadOutcome;
		// WebCrypto (`crypto.subtle`) exists only in a secure context, so a console served over plain
		// HTTP can never seal the download. Say that, rather than blaming the browser. (Compared with
		// `false` so an environment that does not report the flag at all falls to the probe below.)
		if (window.isSecureContext === false) {
			outcome = { kind: "insecure-context" };
		} else if (!(await x25519Supported())) {
			outcome = { kind: "unsupported" };
		} else {
			try {
				outcome = await runKubeconfigDownload({
					clusterId,
					fileName: kubeconfigFileName(projectName, environment),
					request: requestKubeconfigDownload,
					poll: pollKubeconfigDownload,
					save: saveAsFile,
					beforeRead: wait.arm,
					waitForChange: (deadline) => wait.changed(deadline, controller.signal),
					signal: controller.signal,
					onQueued: (expiresAt) =>
						setState((current) => (current.phase === "working" ? { ...current, expiresAt } : current)),
					onPrivateEndpoint: setPrivateEndpoint,
				});
			} catch {
				outcome = { kind: "refused", status: 500 };
			}
		}
		if (abort.current !== controller) return;
		clearSlowTimer();
		if (controller.signal.aborted || outcome.kind === "cancelled") {
			setState({ phase: "idle" });
			return;
		}
		if ("privateEndpoint" in outcome) setPrivateEndpoint(outcome.privateEndpoint);
		setState({ phase: "done", outcome });
	}

	/** Stops the wait. The mint, if the runner still finishes it, expires unread on the server. */
	function cancel() {
		abort.current?.abort();
		abort.current = null;
		clearSlowTimer();
		setPrivateEndpoint(false);
		setState({ phase: "idle" });
	}

	const outcome = state.phase === "done" ? state.outcome : null;
	const working = state.phase === "working" ? state : null;

	return (
		<div className="flex flex-col gap-1" data-slot="kubeconfig-download">
			<div className="flex flex-wrap items-center gap-2">
				<Button
					variant="outline"
					size="sm"
					className="h-7 text-ui-xs"
					disabled={working !== null}
					aria-busy={working !== null}
					onClick={() => void start()}
				>
					{working ? <Spinner className="size-3" /> : <Download className="size-3" />}
					Download kubeconfig (1h, read-only)
				</Button>
				{working && (
					<Button variant="ghost" size="sm" className="h-7 text-ui-xs" onClick={cancel}>
						Cancel
					</Button>
				)}
			</div>
			{working && (
				<p role="status" className="text-ui-xs text-text-tertiary">
					{working.slow ? "Still waiting for a runner to mint it." : "A runner is minting it."}
					{working.expiresAt && <> The request expires {formatDate(working.expiresAt, "datetime")}.</>}
					{working.slow && (
						<>
							{" "}
							If no runner is online it cannot finish:{" "}
							<Link href={globalHref(orgSlug, "runners")} className="underline underline-offset-2">
								check the runners
							</Link>
							.
						</>
					)}
				</p>
			)}
			{outcome?.kind === "saved" && (
				<p role="status" className="text-ui-xs text-text-tertiary">
					Saved <span className="font-mono">{outcome.fileName}</span>. It expires{" "}
					{formatRelative(outcome.expiresAt)} ({formatDate(outcome.expiresAt, "datetime")}).
				</p>
			)}
			{outcome && outcome.kind !== "saved" && outcome.kind !== "cancelled" && (
				<p role="alert" className="text-ui-xs text-destructive">
					{outcomeMessage(outcome)}
				</p>
			)}
			{privateEndpoint && <p className="text-ui-xs text-text-secondary">{PRIVATE_ENDPOINT_NOTICE}</p>}
		</div>
	);
}
