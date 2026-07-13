// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Building2, CircleDollarSign, LifeBuoy } from "lucide-react";
import Link from "next/link";
import type React from "react";
import { cn } from "@repo/ui/utils";

/** Which top-nav section is active (drives the highlighted link). */
export type StaffNav = "cases" | "spend" | "orgs";

/** The staff-console top-nav sections: label + route + active key. */
const NAV: { key: StaffNav; label: string; href: string }[] = [
	{ key: "cases", label: "Cases", href: "/" },
	{ key: "spend", label: "AI spend", href: "/spend" },
	{ key: "orgs", label: "Orgs", href: "/orgs" },
];

/**
 * The minimal chrome for the admin console — a slim top bar with the "Alethia staff"
 * brand + the cross-tenant nav (Cases · AI spend), the acting staff email on the right, and
 * a centered max-width content column. This dashboard is cross-tenant and has no org
 * sidebar; the whole subdomain sits behind Cloudflare Access. `active` highlights the
 * current section.
 */
export function StaffShell({
	staffEmail,
	active = "cases",
	children,
}: {
	staffEmail: string;
	active?: StaffNav;
	children: React.ReactNode;
}) {
	return (
		<div className="min-h-dvh bg-background text-foreground">
			<header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
				<div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-4 px-4">
					<div className="flex items-center gap-6">
						<Link
							href="/"
							className="flex items-center gap-2 text-sm font-medium"
						>
							<LifeBuoy className="size-4 text-muted-foreground" />
							Alethia staff
						</Link>
						<nav className="flex items-center gap-4">
							{NAV.map((item) => (
								<Link
									key={item.key}
									href={item.href}
									aria-current={active === item.key ? "page" : undefined}
									className={cn(
										"flex items-center gap-1.5 text-sm transition-colors hover:text-foreground",
										active === item.key
											? "font-medium text-foreground"
											: "text-muted-foreground",
									)}
								>
									{item.key === "spend" && (
										<CircleDollarSign className="size-4" />
									)}
									{item.key === "orgs" && <Building2 className="size-4" />}
									{item.label}
								</Link>
							))}
						</nav>
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
