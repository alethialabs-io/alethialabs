"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Menu, Plus, Search } from "lucide-react";
import Link from "next/link";
import { DownloadCliButton } from "@/components/download-cli-button";
import { EnvSwitcher } from "@/components/env-switcher";
import { HeaderBreadcrumbs } from "@/components/header-breadcrumbs";
import { SpecSwitcher } from "@/components/spec-switcher";
import { Button } from "@/components/ui/button";
import { ZoneSwitcher } from "@/components/zone-switcher";
import { globalHref } from "@/lib/routing";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";

/**
 * The main-column topbar: zone / spec / env quick-switchers on the left, the route
 * breadcrumb centered in a pill (hidden when empty, e.g. on the zones overview), and the
 * primary "Create" action on the right alongside the CLI download. Feedback and ⌘K are
 * visible stubs until those features land.
 */
export function Topbar({ onOpenSidebar }: { onOpenSidebar: () => void }) {
	const orgSlug = useActiveOrgSlug();

	return (
		<header className="relative flex h-[53px] shrink-0 items-center gap-1 border-b bg-background px-2 sm:px-4">
			<Button
				variant="ghost"
				size="icon"
				className="h-9 w-9 shrink-0 lg:hidden"
				onClick={onOpenSidebar}
				aria-label="Open navigation"
			>
				<Menu className="h-5 w-5" />
			</Button>

			<ZoneSwitcher variant="topbar" />
			<SpecSwitcher variant="topbar" />
			<EnvSwitcher variant="topbar" />

			{/* Centered breadcrumb pill — collapses to nothing on the bare overview. */}
			<div className="pointer-events-none absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 md:block">
				<div className="pointer-events-auto flex items-center rounded-full border bg-muted/40 px-3.5 py-1 empty:hidden">
					<HeaderBreadcrumbs />
				</div>
			</div>

			<div className="ml-auto flex items-center gap-1.5">
				<button
					type="button"
					disabled
					className="hidden h-8 cursor-not-allowed items-center rounded-md px-2.5 text-[12.5px] text-muted-foreground opacity-60 sm:inline-flex"
				>
					Feedback
				</button>
				<button
					type="button"
					disabled
					className="hidden h-8 cursor-not-allowed items-center gap-1.5 rounded-md border px-2.5 text-muted-foreground opacity-60 sm:inline-flex"
				>
					<Search className="h-3.5 w-3.5" />
					<span className="font-mono text-[11px]">⌘K</span>
				</button>
				<Button asChild size="sm" className="h-8 gap-1.5">
					<Link href={globalHref(orgSlug, "design-spec")}>
						<Plus className="h-4 w-4" />
						Create
					</Link>
				</Button>
				<DownloadCliButton />
			</div>
		</header>
	);
}
