"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The region boundary for support, inside the support layout (polish-wave spec §4, #7741). A failure below this
// segment replaces this region only: the shell, the sidebar and every other page stay mounted, so
// one region's failure no longer takes the whole org page with it. Copy, retry and `ref` follow
// the region form every data-region boundary shares; `tests/components/errors/` holds the form.

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@repo/ui/button";
import { ErrorState } from "@repo/ui/error-state";
import { captureException } from "@/lib/analytics/track";

/** Renders support, inside the support layout when it fails, with a retry that re-reads only this segment. */
export default function SupportError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	const router = useRouter();
	const [retrying, startRetry] = useTransition();

	useEffect(() => {
		captureException(error, { boundary: "support", digest: error.digest });
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
			title="Support didn't load"
			description="We couldn't load support just now. Your cases are unaffected, and you can still write to us by email."
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
