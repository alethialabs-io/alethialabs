// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";
import { AlethiaMark } from "@repo/brand/lockup";
import { ErrorState } from "@repo/ui/error-state";
import { Button } from "@repo/ui/button";

export const metadata: Metadata = { title: "Not found" };

/**
 * App-wide 404 for unmatched URLs and any unscoped notFound(). The polish-wave 404 form (spec §4,
 * #7741): "Nothing here.", the likely reason, and the ways out. The `code` stays the bare "404" —
 * the e2e navigation-shell spec finds every 404 by that exact text — and this stays the only 404
 * carrying "Sign in", which that spec uses to tell this page from the org one.
 */
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
