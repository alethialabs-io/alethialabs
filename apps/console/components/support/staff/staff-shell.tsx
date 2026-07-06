// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { LifeBuoy } from "lucide-react";
import Link from "next/link";
import type React from "react";

/**
 * The minimal chrome for the /support-admin console — deliberately NOT the customer
 * AppShell (this dashboard is cross-tenant and off the org sidebar). A slim top bar with
 * the "Support admin" title + a "Cases" link back to the list, the acting staff email on
 * the right, and a centered max-width content column.
 */
export function StaffShell({
	staffEmail,
	children,
}: {
	staffEmail: string;
	children: React.ReactNode;
}) {
	return (
		<div className="min-h-dvh bg-background text-foreground">
			<header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
				<div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-4 px-4">
					<div className="flex items-center gap-6">
						<Link
							href="/support-admin"
							className="flex items-center gap-2 text-sm font-medium"
						>
							<LifeBuoy className="size-4 text-muted-foreground" />
							Support admin
						</Link>
						<Link
							href="/support-admin"
							className="text-sm text-muted-foreground transition-colors hover:text-foreground"
						>
							Cases
						</Link>
					</div>
					<span className="truncate font-mono text-xs text-muted-foreground">
						{staffEmail}
					</span>
				</div>
			</header>
			<main className="mx-auto w-full max-w-5xl px-4 py-6">{children}</main>
		</div>
	);
}
