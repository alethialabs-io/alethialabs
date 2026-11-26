"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// In-shell error boundary for the project workspace. Render errors below the project layout land
// here — closer than the org boundary — keeping the app shell + project sidebar mounted instead of
// a full-page takeover.
//
// The copy is the route-error form of the polish-wave spec (§4, #7741): what happened, the
// reassurance that nothing in the person's cloud changed, Try again / Contact support, and the
// `ref <digest> · <UTC time>` a support conversation starts from. The data regions below this one
// have their own boundaries (`~/clusters/error.tsx` and the rest), so this answers only what none
// of them covers.

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { formatDate } from "@repo/format";
import { ErrorState } from "@repo/ui/error-state";
import { Button } from "@repo/ui/button";
import { captureException } from "@/lib/analytics/track";
import { globalHref } from "@/lib/routing";

/** The project workspace's in-shell route error: retry, the org's support page, and the ref line. */
export default function ProjectError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	const { org } = useParams<{ org: string }>();
	const router = useRouter();
	const [retrying, startRetry] = useTransition();
	// The instant the boundary first rendered, reported in UTC on the `ref` line.
	const [at] = useState(() => new Date());

	useEffect(() => {
		console.error("[project] error:", error.digest ?? error.message, error);
		captureException(error, { boundary: "project", digest: error.digest });
	}, [error]);

	/** Re-fetches this segment's server data, then re-renders it in place of the error. */
	function retry() {
		startRetry(() => {
			router.refresh();
			reset();
		});
	}

	return (
		<ErrorState
			title="Something broke on our side."
			description="Nothing in your cloud changed."
			actions={
				<>
					<Button size="sm" pending={retrying} onClick={retry}>
						Try again
					</Button>
					<Button
						size="sm"
						variant="outline"
						nativeButton={false}
						render={<Link href={globalHref(org, "support")} />}
					>
						Contact support
					</Button>
					<span
						suppressHydrationWarning
						className="basis-full select-all font-mono text-ui-xs text-text-tertiary"
					>
						{error.digest ? `ref ${error.digest} · ` : ""}
						{formatDate(at, "datetime", "UTC")} UTC
					</span>
				</>
			}
		/>
	);
}
