"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Loader2, RefreshCw, Plug, SearchX } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { globalHref } from "@/lib/routing";
import { Button } from "@repo/ui/button";

/** The non-READY results of getScanProposal. */
type NotReady =
	| { status: "NOT_FOUND" }
	| { status: "PENDING"; jobStatus: string }
	| { status: "NEEDS_SETUP"; needsIdentity: boolean };

/**
 * Status surface for a repo scan that isn't ready to review yet — shown on
 * `/{org}/~/new?scan=<jobId>` when the proposal is still pending, needs a connected
 * cloud, or the job is gone. Keeps the user in the flow instead of dropping them on
 * the bare create form.
 */
export function ScanReviewNotice({
	org,
	result,
}: {
	org: string;
	result: NotReady;
}) {
	const router = useRouter();

	return (
		<div className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
			{result.status === "PENDING" && (
				<>
					<Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
					<div className="space-y-1">
						<h1 className="text-lg font-semibold">Scanning your repository…</h1>
						<p className="text-sm text-muted-foreground">
							We&apos;re analyzing the repo to infer what to provision (status: {result.jobStatus}).
							This usually takes under a minute.
						</p>
					</div>
					<Button
						variant="outline"
						className="gap-1.5 rounded-none"
						onClick={() => router.refresh()}
					>
						<RefreshCw className="h-3.5 w-3.5" />
						Check again
					</Button>
				</>
			)}

			{result.status === "NEEDS_SETUP" && (
				<>
					<Plug className="h-8 w-8 text-muted-foreground" />
					<div className="space-y-1">
						<h1 className="text-lg font-semibold">Connect a cloud first</h1>
						<p className="text-sm text-muted-foreground">
							We inferred a stack from your repo, but you need a verified cloud account to
							target it. Connect one, then re-open the scan.
						</p>
					</div>
					<Button asChild className="gap-1.5 rounded-none">
						<Link href={globalHref(org, "connectors")}>
							<Plug className="h-3.5 w-3.5" />
							Connect a cloud
						</Link>
					</Button>
				</>
			)}

			{result.status === "NOT_FOUND" && (
				<>
					<SearchX className="h-8 w-8 text-muted-foreground" />
					<div className="space-y-1">
						<h1 className="text-lg font-semibold">Scan not found</h1>
						<p className="text-sm text-muted-foreground">
							This scan no longer exists. Start a new project and scan your repo again.
						</p>
					</div>
					<Button asChild variant="outline" className="gap-1.5 rounded-none">
						<Link href={globalHref(org, "new")}>Start a new project</Link>
					</Button>
				</>
			)}
		</div>
	);
}
