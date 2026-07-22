"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// App-wide recoverable error boundary — catches render/data errors in any page
// below the root layout (public + private). Rendered inside the root layout, so
// the theme + fonts apply. A catastrophic root-layout failure is handled by
// global-error.tsx instead.

import { useEffect } from "react";
import Link from "next/link";
import { captureException } from "@/lib/analytics/track";
import { ErrorState } from "@/components/errors/error-state";
import { Button } from "@repo/ui/button";

export default function AppError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		console.error("[app] render error:", error.digest ?? error.message, error);
		captureException(error, { boundary: "app", digest: error.digest });
	}, [error]);

	return (
		<ErrorState
			fullPage
			code="Error"
			title="Something went wrong"
			description="An unexpected error occurred. You can try again, or head back home."
			actions={
				<>
					<Button size="sm" onClick={reset}>
						Try again
					</Button>
					<Button size="sm" variant="outline" nativeButton={false} render={<Link href="/" />}>
						Go home
					</Button>
				</>
			}
		/>
	);
}
