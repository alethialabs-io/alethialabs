"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Search } from "lucide-react";
import { usePathname } from "next/navigation";
import { buildSidebarNav, type DrillId, isNavItemActive } from "./nav-config";
import { NavRow } from "./nav-row";

/**
 * The main sidebar view: a stubbed "Find…" box plus the three nav groups (top, connect,
 * and a pinned-bottom group). Drill triggers either navigate (route-owned) or call
 * `onOpenDrill` to slide a sub-view in.
 */
export function SidebarNav({
	orgSlug,
	onOpenDrill,
}: {
	orgSlug: string;
	onOpenDrill: (id: DrillId) => void;
}) {
	const pathname = usePathname();
	const groups = buildSidebarNav(orgSlug);

	return (
		<div className="flex h-full flex-col">
			{/* Find box — visual stub (a global command palette will back this later). */}
			<div className="px-3 pb-2 pt-3">
				<button
					type="button"
					disabled
					className="flex h-9 w-full cursor-not-allowed items-center gap-2.5 rounded-md border bg-muted/30 px-2.5 text-muted-foreground"
				>
					<Search className="h-[15px] w-[15px] shrink-0" />
					<span className="flex-1 text-left text-[13px]">Find…</span>
					<span className="shrink-0 rounded border px-1.5 font-mono text-[10px]">F</span>
				</button>
			</div>

			<nav className="flex flex-1 flex-col overflow-y-auto px-3 pb-3">
				<div className="space-y-0.5">
					{groups.top.map((item) => (
						<NavRow
							key={item.label}
							item={item}
							active={isNavItemActive(item, pathname)}
							onOpenDrill={onOpenDrill}
						/>
					))}
				</div>

				<div className="my-2 h-px bg-border" />

				<div className="space-y-0.5">
					{groups.connect.map((item) => (
						<NavRow
							key={item.label}
							item={item}
							active={isNavItemActive(item, pathname)}
							onOpenDrill={onOpenDrill}
						/>
					))}
				</div>

				<div className="mt-auto space-y-0.5 pt-3">
					{groups.pinned.map((item) => (
						<NavRow
							key={item.label}
							item={item}
							active={isNavItemActive(item, pathname)}
							onOpenDrill={onOpenDrill}
						/>
					))}
				</div>
			</nav>
		</div>
	);
}
