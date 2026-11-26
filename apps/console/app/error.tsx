"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// App-wide recoverable error boundary — catches render/data errors in any page
// below the root layout (public + private). Rendered inside the root layout, so
// the theme + fonts apply. A catastrophic root-layout failure is handled by
// global-error.tsx instead.
//
// The copy is the route-error form of the polish-wave spec (§4, #7741): what happened, then the
// reassurance an infrastructure product owes — a failed page changed nothing in anyone's cloud —
// then the `ref` a support conversation starts from. "Contact support" is a mail link here, not the
// console's support page: this boundary also covers the signed-out pages, where that page is not
// reachable.

import { useEffect, useState } from "react";
import { formatDate } from "@repo/format";
import { AlethiaMark } from "@repo/brand/lockup";
import { LEGAL_ENTITY } from "@repo/legal/entity";
import { ErrorState } from "@repo/ui/error-state";
import { Button } from "@repo/ui/button";
import { captureException } from "@/lib/analytics/track";

/** The root error boundary: the full-page route-error form, with retry and a mail link to support. */
export default function AppError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	// The instant the boundary first rendered: what the `ref` line reports, pinned to UTC so the
	// person and support read the same time.
	const [at] = useState(() => new Date());

	useEffect(() => {
		console.error("[app] render error:", error.digest ?? error.message, error);
		captureException(error, { boundary: "app", digest: error.digest });
	}, [error]);

	return (
		<ErrorState
			fullPage
			// The hollow dot is the brand's "failed" shape: the mark's point, drawn as a ring.
			mark={<AlethiaMark className="[&_circle]:fill-none [&_circle]:stroke-current [&_circle]:[stroke-width:1.6]" />}
			title="Something broke on our side."
			description="Nothing in your cloud changed."
			actions={
				<>
					<Button size="sm" onClick={reset}>
						Try again
					</Button>
					<Button
						size="sm"
						variant="outline"
						nativeButton={false}
						render={<a href={`mailto:${LEGAL_ENTITY.supportEmail}`} />}
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
