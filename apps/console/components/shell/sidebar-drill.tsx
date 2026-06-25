"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SettingsNav } from "@/components/settings/settings-nav";
import { orgHref } from "@/lib/routing";
import { type DrillDef, isNavItemActive } from "./nav-config";
import { NavRow } from "./nav-row";

/**
 * A drill-in sub-view: a back header (left chevron + section title) above the section's
 * nav. The Settings drill reuses `<SettingsNav/>` (with its entitlement gating); the
 * others render their config items (real anchors + "Soon" stubs). Route-owned drills back
 * out by navigating to the org overview; the click-only drill backs out via `onBack`.
 */
export function SidebarDrill({
	drill,
	orgSlug,
	onBack,
}: {
	drill: DrillDef;
	orgSlug: string;
	onBack: () => void;
}) {
	const pathname = usePathname();
	const headClassName =
		"flex flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-[13.5px] font-semibold text-foreground transition-colors hover:bg-muted/60";

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-[53px] shrink-0 items-center border-b px-2.5">
				{drill.routeOwned ? (
					<Link href={orgHref(orgSlug)} className={headClassName}>
						<ChevronLeft className="h-4 w-4 text-muted-foreground" />
						{drill.title}
					</Link>
				) : (
					<button type="button" onClick={onBack} className={headClassName}>
						<ChevronLeft className="h-4 w-4 text-muted-foreground" />
						{drill.title}
					</button>
				)}
			</div>

			<nav className="flex-1 overflow-y-auto p-3">
				{drill.id === "settings" ? (
					<SettingsNav />
				) : (
					<div className="space-y-0.5">
						{drill.items?.map((item) => (
							<NavRow key={item.label} item={item} active={isNavItemActive(item, pathname)} />
						))}
					</div>
				)}
			</nav>
		</div>
	);
}
