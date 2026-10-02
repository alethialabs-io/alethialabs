"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// "Download kubeconfig (1h, read-only)" — the cluster card's stage-2 access action (#5285, design
// #5250 decisions 4, 6, 7). It sits under the stage-1 command in the card's "Cluster access" block.
//
// Rendered only for a person holding `cluster:access_readonly` (asked of the server; the request
// re-checks). The key is generated, the seal opened and the file built in THIS browser; the console
// relays ciphertext it cannot open. See flow.ts for the sequence and hpke.ts for the construction.

import { formatDate, formatRelative } from "@repo/format";
import { Button } from "@repo/ui/button";
import { Spinner } from "@repo/ui/spinner";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	canDownloadKubeconfig,
	pollKubeconfigDownload,
	requestKubeconfigDownload,
} from "@/app/server/actions/kubeconfig-download";
import { kubeconfigFileName } from "./credential";
import { type DownloadOutcome, outcomeMessage, runKubeconfigDownload, saveAsFile } from "./flow";
import { x25519Supported } from "./hpke";

/** What the control shows. */
type DownloadState =
	| { phase: "idle" }
	| { phase: "working" }
	| { phase: "done"; outcome: DownloadOutcome };

/** The sentence decision 6 asks for: said plainly, not hidden behind an icon. */
const PRIVATE_ENDPOINT_NOTICE =
	"This cluster's API endpoint is private. The kubeconfig works only from a network that can reach it, such as over a VPN or through a bastion.";

/**
 * The download control for one cluster. Hidden (renders nothing) until the server confirms the caller
 * holds `cluster:access_readonly`, and for anyone who does not.
 */
export function KubeconfigDownload({
	clusterId,
	projectName,
	environment,
}: {
	clusterId: string;
	projectName: string;
	environment: string;
}) {
	const { data: allowed = false } = useQuery({
		queryKey: ["clusters", "kubeconfig-download", "allowed", clusterId],
		queryFn: () => canDownloadKubeconfig(clusterId),
		staleTime: 5 * 60_000,
	});
	const [state, setState] = useState<DownloadState>({ phase: "idle" });
	const [privateEndpoint, setPrivateEndpoint] = useState(false);
	const abort = useRef<AbortController | null>(null);

	// Leaving the page stops the poll; the server's sweep expires the unread mint.
	useEffect(() => () => abort.current?.abort(), []);

	if (!allowed) return null;

	/** Runs one download and records how it ended. */
	async function start() {
		setState({ phase: "working" });
		setPrivateEndpoint(false);
		const controller = new AbortController();
		abort.current = controller;
		let outcome: DownloadOutcome;
		if (!(await x25519Supported())) {
			outcome = { kind: "unsupported" };
		} else {
			try {
				outcome = await runKubeconfigDownload({
					clusterId,
					fileName: kubeconfigFileName(projectName, environment),
					request: requestKubeconfigDownload,
					poll: pollKubeconfigDownload,
					save: saveAsFile,
					signal: controller.signal,
					onPrivateEndpoint: setPrivateEndpoint,
				});
			} catch {
				outcome = { kind: "refused", status: 500 };
			}
		}
		if (controller.signal.aborted) return;
		if ("privateEndpoint" in outcome) setPrivateEndpoint(outcome.privateEndpoint);
		setState({ phase: "done", outcome });
	}

	const outcome = state.phase === "done" ? state.outcome : null;

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center gap-2">
				<Button
					variant="outline"
					size="sm"
					className="h-7 text-ui-xs"
					disabled={state.phase === "working"}
					onClick={() => void start()}
				>
					{state.phase === "working" ? <Spinner className="size-3" /> : <Download className="size-3" />}
					Download kubeconfig (1h, read-only)
				</Button>
				{state.phase === "working" && (
					<span role="status" className="text-ui-2xs text-text-tertiary">
						Minting on the runner…
					</span>
				)}
			</div>
			{outcome?.kind === "saved" && (
				<p role="status" className="text-ui-2xs text-text-tertiary">
					Saved <span className="font-mono">{outcome.fileName}</span>. It expires{" "}
					{formatRelative(outcome.expiresAt)} ({formatDate(outcome.expiresAt, "datetime")}).
				</p>
			)}
			{outcome && outcome.kind !== "saved" && outcome.kind !== "cancelled" && (
				<p role="alert" className="text-ui-2xs text-destructive">
					{outcomeMessage(outcome)}
				</p>
			)}
			{privateEndpoint && <p className="text-ui-2xs text-text-secondary">{PRIVATE_ENDPOINT_NOTICE}</p>}
		</div>
	);
}
