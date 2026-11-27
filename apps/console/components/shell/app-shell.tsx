"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The dashboard shell (Vercel-style): a fixed sidebar + a main column with the topbar and a
// scrolling canvas. Mounted once by `app/(private)/[org]/layout.tsx` for the whole C2 slug
// tree. Replaces the legacy header-centric `DashboardChrome`.

import type React from "react";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { MarkLoader } from "@repo/brand/loader";
import { Sheet, SheetContent, SheetTitle } from "@repo/ui/sheet";
import { cn } from "@repo/ui/utils";
import { useSidebarCollapse } from "@/lib/stores/use-sidebar-store";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import { useWorkspaceStoreSync } from "@/lib/stores/use-workspace-store";
import { ElenchDraftsRoot } from "@/components/agent/elench/elench-drafts-root";
import { ElenchSurfaceLoader } from "@/components/agent/elench/elench-surface-loader";
import { AnalyticsIdentity } from "@/components/analytics/analytics-identity";
import { SetupGuideCard } from "@/components/onboarding/setup-guide";
import { AppSidebar } from "./app-sidebar";
import { CommandPalette } from "./command-palette";
import { CONTENT_FRAME } from "./content-frame";
import { CRUMB_STRIP_VARS, MAIN_COLUMN_VARS, MAIN_UNDER_CRUMB_STRIP } from "./crumb-strip";
import { JobToaster } from "./job-toaster";
import { RealtimeMount } from "./realtime-mount";
import { RouteProgress } from "./route-progress";
import type { ShellEdition } from "./shell-edition";
import { ShellEditionProvider } from "./shell-edition-provider";
import { SidebarRail } from "./sidebar-rail";
import { SupportToaster } from "./support-toaster";
import { Topbar } from "./topbar";

/**
 * What the main column shows while a page below it suspends with no `loading.tsx` of its own: the
 * page-size `[·]` loader (polish-wave spec §2). It used to be a generic toolbar-and-rows skeleton,
 * but a skeleton promises a layout, and this boundary is reached precisely when nobody knows the
 * page's layout — a page that does know it has its own `loading.tsx`, which wins. Skeletons stay
 * there; the mark never replaces one.
 */
function MainPending() {
	return <MarkLoader size="page" />;
}

/** What the `[org]` layout hands the shell. */
interface AppShellProps {
	children: React.ReactNode;
	/**
	 * The instance edition, as the `[org]` layout read it from `getInstanceEdition()`. Everything
	 * in the shell that differs by edition reads it through `useShellEdition`.
	 */
	edition: ShellEdition;
	/** Org runs its own runners → surfaces the gated Runners nav item. */
	selfRunners?: boolean;
	/**
	 * The page's `currentActor().orgId` (ADR 0003 §6.1), kept in the Elench store where the chat
	 * transport reads it at request time as the turn's `orgId`.
	 */
	pageOrgId?: string | null;
}

/**
 * The authenticated dashboard chrome: sidebar + topbar + scrolling content canvas, with the
 * instance edition provided to everything in it.
 */
export function AppShell({ edition, ...frame }: AppShellProps) {
	return (
		<ShellEditionProvider edition={edition}>
			<ShellFrame {...frame} />
		</ShellEditionProvider>
	);
}

/** The chrome itself. Split from `AppShell` so that it renders inside the edition provider. */
function ShellFrame({
	children,
	selfRunners = false,
	pageOrgId = null,
}: Omit<AppShellProps, "edition">) {
	const [mobileOpen, setMobileOpen] = useState(false);

	// Inside a project the sidebar can collapse to a 56px icon rail (the Architecture canvas wants the
	// width); it stays the full sidebar on every other project view and always at org scope. A nested
	// drill (Settings) force-expands it, and a manual toggle pins the user's choice. See useSidebarCollapse.
	const { collapsed } = useSidebarCollapse();

	// The project workspace is the one subtree this frame must NOT wrap. `ProjectShell` mounts
	// below this shell and is a full-viewport surface — the Architecture canvas pans to the edge
	// and the docked inspector is pinned to the right rail — so it applies CONTENT_FRAME itself,
	// to its scrolling views only. A cap on this ancestor would be inescapable from down there:
	// ProjectShell's `-m-4 … -m-10` cancels padding, but no negative margin can cancel a
	// `max-w-*` whose overflow it cannot measure. Org-scoped routes are `/{org}` and `/{org}/~/…`;
	// anything with a second segment that is not `~` is the workspace.
	const segments = usePathname().split("/").filter(Boolean);
	const isProjectWorkspace = segments.length >= 2 && segments[1] !== "~";

	// Settle the workspace store (the entitlement gates) from the context the `[org]` layout
	// prefetched and hydrated — no request of its own (#6114).
	useWorkspaceStoreSync();

	// Keep the page's org where the chat transport reads it at request time (ADR 0003 §9.1).
	useEffect(() => {
		useElenchStore.getState().setPageOrgId(pageOrgId);
	}, [pageOrgId]);

	return (
		<div className={cn("flex h-dvh w-full overflow-hidden bg-background", CRUMB_STRIP_VARS)}>
			{/* Desktop sidebar — collapses to a 56px icon rail on the project canvas. */}
			<aside
				className={cn(
					"hidden shrink-0 border-r lg:block",
					collapsed ? "w-[56px]" : "w-[252px]",
				)}
			>
				{collapsed ? (
					<SidebarRail selfRunners={selfRunners} />
				) : (
					<AppSidebar selfRunners={selfRunners} />
				)}
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
					<AppSidebar selfRunners={selfRunners} />
				</SheetContent>
			</Sheet>

			{/* Main column */}
			<div className={cn("flex min-w-0 flex-1 flex-col", MAIN_COLUMN_VARS)}>
				<Topbar onOpenSidebar={() => setMobileOpen(true)} />
				{/* The route hairline, pinned to the top edge of the content area: under the topbar, and
				    under the breadcrumb strip below `md`. A zero-height box, so it takes no room; the
				    Suspense is for its `useSearchParams`. */}
				<div className="relative h-0 max-md:top-(--shell-crumb-h)">
					<Suspense fallback={null}>
						<RouteProgress />
					</Suspense>
				</div>
				{/* Below `md` the breadcrumb is a strip under the topbar, and `<main>` starts under it
				    (`./crumb-strip.ts`). */}
				<main className={cn("flex-1 overflow-y-auto", MAIN_UNDER_CRUMB_STRIP)}>
					<Suspense fallback={<MainPending />}>
						<div className="p-4 sm:p-6 lg:p-8 xl:p-10">
							{isProjectWorkspace ? (
								children
							) : (
								<div className={CONTENT_FRAME}>{children}</div>
							)}
						</div>
					</Suspense>
				</main>
			</div>

			{/* The global Elench assistant surface. In panel view it renders as an in-flow flex
			    child here — its width animates from 0 and squeezes the main column (true seam
			    border, like the canvas inspector). In modal view it portals out (Radix Dialog),
			    leaving this slot empty. One surface per session. Its drafts root runs whether or not
			    the surface is open, so unsent words keep saving (ADR 0001). */}
			<ElenchDraftsRoot pageOrgId={pageOrgId}>
				<ElenchSurfaceLoader />
			</ElenchDraftsRoot>

			{/* Global command palette: the sidebar "Find…" box and the registry's palette shortcut. */}
			<CommandPalette selfRunners={selfRunners} />

			{/* Single job-lifecycle toast driver (loading → success/failed in place). */}
			<JobToaster />

			{/* Ties the analytics session to the person + active org (identify + group). Headless. */}
			<AnalyticsIdentity />

			{/* Single support-reply toast driver (staff/AI reply → "New reply on CASE-…"). */}
			<SupportToaster />

			{/* The org's change stream (ADR 0005 D3, #6115) and its connection notice: a fixed live region, no layout. */}
			<RealtimeMount />

			{/* First-run "Setup guide" — toggled from the topbar button, floats bottom-right. */}
			<SetupGuideCard />
		</div>
	);
}
