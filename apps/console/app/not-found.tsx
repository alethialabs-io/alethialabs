// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";
import { ErrorState } from "@repo/ui/error-state";
import { Button } from "@repo/ui/button";

export const metadata: Metadata = { title: "Not found" };

/**
 * App-wide 404 for unmatched URLs and any unscoped notFound(). The signed-off 404 form (spec §4,
 * #7875): `[ 404 ]` in the mark's brackets, "Nothing here.", a reason line saying what is missing,
 * and the ways out. The code's text stays the bare "404" — the e2e navigation-shell spec finds every
 * 404 by that exact text — and this stays the only 404 carrying "Sign in" and this reason line,
 * which that spec uses to tell this page from the org one. The bracketed code replaces the mark: it
 * IS the mark, with the code where the dot was.
 */
export default function NotFound() {
	return (
		<ErrorState
			fullPage
			code="404"
			codeVariant="bracketed"
			title="Nothing here."
			description="There's no page at this address. The link may be out of date, or the page has moved."
			actions={
				<>
					<Button size="sm" nativeButton={false} render={<Link href="/" />}>
						Go home
					</Button>
					<Button size="sm" variant="outline" nativeButton={false} render={<Link href="/login" />}>
						Sign in
					</Button>
				</>
			}
		/>
	);
}
