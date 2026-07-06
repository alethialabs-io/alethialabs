"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The dashboard shell (Vercel-style): a fixed sidebar + a main column with the topbar and a
// scrolling canvas. Mounted once by `app/(private)/[org]/layout.tsx` for the whole C2 slug
// tree. Replaces the legacy header-centric `DashboardChrome`.

import type React from "react";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Sheet, SheetContent, SheetTitle } from "@repo/ui/sheet";
import { cn } from "@repo/ui/utils";
import { useJobsQuery } from "@/lib/query/use-jobs-query";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";
import { ElenchSurface } from "@/components/agent/elench/elench-surface";
import { SetupGuideCard } from "@/components/onboarding/setup-guide";
import { AppSidebar } from "./app-sidebar";
import { CommandPalette } from "./command-palette";
import { JobToaster } from "./job-toaster";
import { projectScope } from "./nav-config";
import { SidebarRail } from "./sidebar-rail";
import { SupportToaster } from "./support-toaster";
import { Topbar } from "./topbar";

/** The authenticated dashboard chrome: sidebar + topbar + scrolling content canvas. */
export function AppShell({
	children,
	isHosted = false,
}: {
	children: React.ReactNode;
	/** Hosted control plane → enables the in-app feedback widget in the sidebar. */
	isHosted?: boolean;
}) {
	const [mobileOpen, setMobileOpen] = useState(false);

	// Inside a project (`/{org}/{project}/…`) the sidebar collapses to an icon rail — the project
	// workspace navigates via that rail while its views render in the content area. Org routes keep
	// the full sidebar.
	const pathname = usePathname();
	const collapsed = projectScope(pathname) != null;

	// Load the workspace once here so every nav href resolves to the active org even
	// before the org switcher mounts (the switcher used to be the only loader).
	useEffect(() => {
		useWorkspaceStore.getState().fetchWorkspace();
	}, []);

	// Warm the shared jobs cache session-wide so the command palette, breadcrumbs, and
	// overview resolve job names everywhere; TanStack Query dedupes and polls it.
	useJobsQuery();

	return (
		<div className="flex h-dvh w-full overflow-hidden bg-background">
			{/* Desktop sidebar — collapses to a 56px icon rail on the project canvas. */}
			<aside
				className={cn(
					"hidden shrink-0 border-r lg:block",
					collapsed ? "w-[56px]" : "w-[252px]",
				)}
			>
				{collapsed ? <SidebarRail /> : <AppSidebar isHosted={isHosted} />}
			</aside>

			{/* Mobile sidebar */}
			<Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
				<SheetContent
					side="left"
					className="w-[252px] p-0"
					onClick={(e) => {
						// Close the drawer when a nav link is tapped (mobile UX).
						if (e.target instanceof Element && e.target.closest("a")) {
							setMobileOpen(false);
						}
					}}
				>
					<SheetTitle className="sr-only">Navigation</SheetTitle>
					<AppSidebar isHosted={isHosted} />
				</SheetContent>
			</Sheet>

			{/* Main column */}
			<div className="flex min-w-0 flex-1 flex-col">
				<Topbar onOpenSidebar={() => setMobileOpen(true)} />
				<main className="flex-1 overflow-y-auto">
					<Suspense
						fallback={
							<div className="flex min-h-[50vh] items-center justify-center">
								<div className="h-6 w-6 animate-spin rounded-full border-2 border-foreground border-t-transparent" />
							</div>
						}
					>
						<div className="p-4 sm:p-6 lg:p-8 xl:p-10">{children}</div>
					</Suspense>
				</main>
			</div>

			{/* Global command palette (the sidebar "Find…" box + ⌘K / F). */}
			<CommandPalette />

			{/* Single job-lifecycle toast driver (loading → success/failed in place). */}
			<JobToaster />

			{/* The global Elench assistant surface (modal / docked panel), one per session. */}
			<ElenchSurface />

			{/* Single support-reply toast driver (staff/AI reply → "New reply on CASE-…"). */}
			<SupportToaster />

			{/* First-run "Setup guide" — toggled from the topbar button, floats bottom-right. */}
			<SetupGuideCard />
		</div>
	);
}
