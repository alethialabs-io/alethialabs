"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import { OrgSwitcher } from "@/components/org-switcher";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { cn } from "@repo/ui/utils";
import {
	buildDrills,
	buildProjectDrills,
	buildProjectSidebarNav,
	buildSidebarNav,
	type DrillId,
	projectScope,
	routeOwnedDrill,
} from "./nav-config";
import { SidebarDrill } from "./sidebar-drill";
import { SidebarNav } from "./sidebar-nav";
import { SidebarProfile } from "./sidebar-profile";

/**
 * The Vercel-style sidebar: org switcher on top, a sliding drill-in nav in the middle, and
 * the profile bar pinned at the bottom. The active drill is derived from the pathname
 * (route-owned drills auto-open on deep links); click-only drills (Observability) open via
 * local state and reset on any navigation. The off-screen panel is inert so focus and the
 * pointer never reach it.
 */
export function AppSidebar({ isHosted = false }: { isHosted?: boolean }) {
	const pathname = usePathname();
	const orgSlug = useActiveOrgSlug();

	// Inside a project drilldown the whole sidebar scopes to that project; at the org overview
	// and org-global (`~`) scope it stays org-wide. Mirrors the scope-aware Settings drill.
	const projectSlug = projectScope(pathname)?.projectSlug ?? null;
	const groups = useMemo(
		() =>
			projectSlug
				? buildProjectSidebarNav(orgSlug, projectSlug)
				: buildSidebarNav(orgSlug),
		[orgSlug, projectSlug],
	);
	const drills = useMemo(
		() =>
			projectSlug
				? buildProjectDrills(orgSlug, projectSlug)
				: buildDrills(orgSlug),
		[orgSlug, projectSlug],
	);

	const routeDrill = routeOwnedDrill(pathname);
	// A click-opened drill (Observability) is scoped to the path it was opened on, so any
	// navigation transparently returns to the main view — no reset effect needed.
	const [manual, setManual] = useState<{ drill: DrillId; path: string } | null>(null);
	const manualDrill = manual?.path === pathname ? manual.drill : null;

	const activeDrill = routeDrill ?? manualDrill;
	const activeDrillDef = activeDrill ? drills[activeDrill] : null;
	const drilled = activeDrill !== null;

	return (
		<div className="flex h-full w-full flex-col bg-background">
			<div className="flex h-[53px] shrink-0 items-center border-b px-2.5">
				<OrgSwitcher />
			</div>

			<div className="relative min-h-0 flex-1 overflow-hidden">
				{/* Main view — slides left + fades while a drill is open. */}
				<div
					inert={drilled}
					className={cn(
						"absolute inset-0 transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none",
						drilled
							? "pointer-events-none -translate-x-7 opacity-0"
							: "translate-x-0 opacity-100",
					)}
				>
					<SidebarNav
						groups={groups}
						onOpenDrill={(id) => setManual({ drill: id, path: pathname })}
					/>
				</div>

				{/* Drill sub-view — slides in from the right. */}
				<div
					inert={!drilled}
					className={cn(
						"absolute inset-0 transition-transform duration-300 ease-out motion-reduce:transition-none",
						drilled ? "translate-x-0" : "pointer-events-none translate-x-full",
					)}
				>
					{activeDrillDef && (
						<SidebarDrill
							drill={activeDrillDef}
							orgSlug={orgSlug}
							onBack={() => setManual(null)}
						/>
					)}
				</div>
			</div>

			<SidebarProfile isHosted={isHosted} />
		</div>
	);
}
