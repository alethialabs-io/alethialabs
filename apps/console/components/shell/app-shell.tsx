"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The dashboard shell (Vercel-style): a fixed sidebar + a main column with the topbar and a
// scrolling canvas. Mounted once by `app/(private)/[org]/layout.tsx` for the whole C2 slug
// tree. Replaces the legacy header-centric `DashboardChrome`.

import type React from "react";
import { Suspense, useEffect, useState } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { authClient } from "@/lib/auth/client";
import { useJobsStore } from "@/lib/stores/use-jobs-store";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";
import { AppSidebar } from "./app-sidebar";
import { Topbar } from "./topbar";

/** The authenticated dashboard chrome: sidebar + topbar + scrolling content canvas. */
export function AppShell({ children }: { children: React.ReactNode }) {
	const [mobileOpen, setMobileOpen] = useState(false);
	const { data: session } = authClient.useSession();
	const user = session?.user ?? null;

	// Load the workspace once here so every nav href resolves to the active org even
	// before the org switcher mounts (the switcher used to be the only loader).
	useEffect(() => {
		useWorkspaceStore.getState().fetchWorkspace();
	}, []);

	// Initial jobs load once a session is present (live updates come from the store poll).
	useEffect(() => {
		if (user) useJobsStore.getState().fetchJobs(true);
	}, [user]);

	return (
		<div className="flex h-dvh w-full overflow-hidden bg-background">
			{/* Desktop sidebar */}
			<aside className="hidden w-[252px] shrink-0 border-r lg:block">
				<AppSidebar />
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
					<AppSidebar />
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
		</div>
	);
}
