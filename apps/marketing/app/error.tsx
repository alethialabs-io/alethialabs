"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The marketing app's recoverable error boundary: a render failure in any page below the root layout
// lands here, inside that layout, so the theme and fonts apply. A root-layout failure is
// `global-error.tsx`. Route-error form of the polish-wave spec (§4, #7741), worded for a public
// page: there is no organization or cloud here to reassure anyone about, so the second line says
// what the reader can do instead. The `ref` is the digest a support message can quote.

import { useEffect } from "react";
import Link from "next/link";
import { AlethiaMark } from "@repo/brand/lockup";
import { Button } from "@repo/ui/button";
import { ErrorState } from "@repo/ui/error-state";

/** The marketing app's route error: retry, contact, and the digest to quote. */
export default function MarketingError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		console.error("[marketing] render error:", error.digest ?? error.message, error);
	}, [error]);

	return (
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
	);
}
