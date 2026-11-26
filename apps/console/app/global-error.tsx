"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Catastrophic boundary — only renders when the ROOT layout itself fails, so it
// must supply its own <html>/<body> and cannot rely on the ThemeProvider. We
// re-declare the fonts + import globals.css so the branded ErrorState still styles
// correctly (defaults to the light token set; no theme class is applied here).
//
// Same route-error form as app/error.tsx (polish-wave spec §4, #7741). Support is a mail link:
// with the root layout down, no console page can be relied on to render.

import { useEffect, useState } from "react";
import { brandFontVariables } from "@repo/brand/fonts";
import { AlethiaMark } from "@repo/brand/lockup";
import { formatDate } from "@repo/format";
import { LEGAL_ENTITY } from "@repo/legal/entity";
import { ErrorState } from "@repo/ui/error-state";
import { Button } from "@repo/ui/button";
import { captureException } from "@/lib/analytics/track";
import "./globals.css";

/** The root-layout failure page: its own document, the route-error form, retry and support. */
export default function GlobalError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	// The instant the boundary first rendered, reported in UTC on the `ref` line.
	const [at] = useState(() => new Date());

	useEffect(() => {
		console.error("[global] root error:", error.digest ?? error.message, error);
		captureException(error, { boundary: "global", digest: error.digest });
	}, [error]);

	return (
		<html lang="en">
			<body className={`${brandFontVariables} antialiased`}>
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
			</body>
		</html>
	);
}
