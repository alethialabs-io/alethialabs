"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The marketing app's catastrophic boundary: it renders only when the ROOT layout itself fails, so it
// supplies its own <html>/<body>, re-declares the brand fonts and imports the stylesheet, and relies
// on no provider (no theme class: the light token set applies). Same copy as `error.tsx`.

import { useEffect } from "react";
import Link from "next/link";
import { brandFontVariables } from "@repo/brand/fonts";
import { AlethiaMark } from "@repo/brand/lockup";
import { Button } from "@repo/ui/button";
import { ErrorState } from "@repo/ui/error-state";
import "./globals.css";

/** The marketing app's root-layout failure page: its own document, retry, contact, and the digest. */
export default function GlobalError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		console.error("[marketing] root error:", error.digest ?? error.message, error);
	}, [error]);

	return (
		<html lang="en">
			<body className={`${brandFontVariables} antialiased`}>
				<ErrorState
					fullPage
					// The hollow dot is the brand's "failed" shape: the mark's point, drawn as a ring.
					mark={<AlethiaMark className="[&_circle]:fill-none [&_circle]:stroke-current [&_circle]:[stroke-width:1.6]" />}
					title="Something broke on our side."
					description="This page didn't load. Try again, or come back in a moment."
					actions={
						<>
							<Button size="sm" onClick={reset}>
								Try again
							</Button>
							<Button size="sm" variant="outline" nativeButton={false} render={<Link href="/contact" />}>
								Contact
							</Button>
							{error.digest ? (
								<span className="basis-full select-all font-mono text-ui-xs text-text-tertiary">
									ref {error.digest}
								</span>
							) : null}
						</>
					}
				/>
			</body>
		</html>
	);
}
