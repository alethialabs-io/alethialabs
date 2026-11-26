"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The region boundary for approvals (polish-wave spec §4, #7741). A failure below this
// segment replaces this region only: the shell, the sidebar and every other page stay mounted, so
// one region's failure no longer takes the whole org page with it. Copy, retry and `ref` follow
// the region form every data-region boundary shares; `tests/components/errors/` holds the form.

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@repo/ui/button";
import { ErrorState } from "@repo/ui/error-state";
import { captureException } from "@/lib/analytics/track";

/**
 * Renders approvals when they fail: the list is replaced, the shell stays, and the copy says the one
 * thing a person deciding needs to hear, that nothing was decided. The retry re-reads only this segment.
 */
export default function ApprovalsError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	const router = useRouter();
	const [retrying, startRetry] = useTransition();

	useEffect(() => {
		captureException(error, { boundary: "approvals", digest: error.digest });
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
			title="Approvals didn't load"
			description="We couldn't read your approvals just now. Requests are safe, and nothing was decided."
			actions={
				<>
					<Button size="sm" pending={retrying} onClick={retry}>
						Try again
					</Button>
					{error.digest ? (
						<span className="basis-full select-all font-mono text-ui-xs text-text-tertiary">
							ref {error.digest}
						</span>
					) : null}
				</>
			}
		/>
	);
}
