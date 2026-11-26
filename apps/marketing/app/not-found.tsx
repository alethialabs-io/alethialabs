// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The marketing 404, in the polish-wave 404 form (spec §4, #7741): the bare "404", "Nothing here.", the
// likely reason, and the ways out. Built on the shared `@repo/ui/error-state`, so a missing page
// reads the same here as in the console. A public page has no organization or cloud to mention.

import type { Metadata } from "next";
import Link from "next/link";
import { AlethiaMark } from "@repo/brand/lockup";
import { Button } from "@repo/ui/button";
import { ErrorState } from "@repo/ui/error-state";

export const metadata: Metadata = { title: "Not found" };

/** The marketing app's 404 for unmatched URLs and any notFound(). */
export default function NotFound() {
	return (
		<ErrorState
			fullPage
			mark={<AlethiaMark />}
			code="404"
			title="Nothing here."
			description="The address may be mistyped, or the page has moved."
			actions={
				<>
					<Button size="sm" nativeButton={false} render={<Link href="/" />}>
						Back to home
					</Button>
					<Button size="sm" variant="outline" nativeButton={false} render={<Link href="/contact" />}>
						Contact
					</Button>
				</>
			}
		/>
	);
}
