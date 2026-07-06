// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";
import { ErrorState } from "@/components/errors/error-state";
import { Button } from "@repo/ui/button";

export const metadata: Metadata = { title: "Not found" };

/** App-wide 404 for unmatched URLs and any unscoped notFound(). */
export default function NotFound() {
	return (
		<ErrorState
			fullPage
			code="404"
			title="Page not found"
			description="The page you're looking for doesn't exist or may have moved."
			actions={
				<>
					<Button asChild size="sm">
						<Link href="/">Go home</Link>
					</Button>
					<Button asChild size="sm" variant="outline">
						<Link href="/login">Sign in</Link>
					</Button>
				</>
			}
		/>
	);
}
