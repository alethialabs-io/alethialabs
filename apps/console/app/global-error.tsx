"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Catastrophic boundary — only renders when the ROOT layout itself fails, so it
// must supply its own <html>/<body> and cannot rely on the ThemeProvider. We
// re-declare the fonts + import globals.css so the branded ErrorState still styles
// correctly (defaults to the light token set; no theme class is applied here).

import { useEffect } from "react";
import { brandFontVariables } from "@repo/brand/fonts";
import { captureException } from "@/lib/analytics/track";
import { ErrorState } from "@/components/errors/error-state";
import { Button } from "@repo/ui/button";
import "./globals.css";

export default function GlobalError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		console.error("[global] root error:", error.digest ?? error.message, error);
		captureException(error, { boundary: "global", digest: error.digest });
	}, [error]);

	return (
		<html lang="en">
			<body
				className={`${brandFontVariables} antialiased`}
			>
				<ErrorState
					fullPage
					code="Error"
					title="Something went wrong"
					description="The application failed to load. Please try again."
					actions={
						<Button size="sm" onClick={reset}>
							Try again
						</Button>
					}
				/>
			</body>
		</html>
	);
}
