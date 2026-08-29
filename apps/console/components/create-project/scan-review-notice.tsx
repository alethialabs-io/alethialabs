"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Loader2, RefreshCw, Plug, SearchX } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { globalHref } from "@/lib/routing";
import { EmptyState } from "@repo/ui/empty";
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
		<div className="mx-auto flex max-w-md flex-col py-16">
			{result.status === "PENDING" && (
				<EmptyState
					level={1}
					icon={<Loader2 className="animate-spin" />}
					title="Scanning your repository…"
					description={`We're analyzing the repo to infer what to provision (status: ${result.jobStatus}). This usually takes under a minute.`}
					action={
						<Button
							variant="outline"
							className="gap-1.5 rounded-none"
							onClick={() => router.refresh()}
						>
							<RefreshCw className="h-3.5 w-3.5" />
							Check again
						</Button>
					}
				/>
			)}

			{result.status === "NEEDS_SETUP" && (
				<EmptyState
					level={1}
					icon={<Plug />}
					title="Connect a cloud first"
					description="We inferred a stack from your repo, but you need a verified cloud account to target it. Connect one, then re-open the scan."
					action={
						<Button className="gap-1.5 rounded-none" nativeButton={false} render={<Link href={globalHref(org, "connectors")} />}>
							<Plug className="h-3.5 w-3.5" />
							Connect a cloud
						</Button>
					}
				/>
			)}

			{result.status === "NOT_FOUND" && (
				<EmptyState
					level={1}
					icon={<SearchX />}
					title="Scan not found"
					description="This scan no longer exists. Start a new project and scan your repo again."
					action={
						<Button variant="outline" className="gap-1.5 rounded-none" nativeButton={false} render={<Link href={globalHref(org, "new")} />}>
							Start a new project
						</Button>
					}
				/>
			)}
		</div>
	);
}
