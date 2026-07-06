"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { usePathname } from "next/navigation";
import { settingsScope } from "@/components/shell/nav-config";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { globalHref, projectSettingsHref } from "@/lib/routing";
import { settingsNavItemsForScope } from "./settings-nav-items";
import { cn } from "@repo/ui/utils";

/** Left section-nav for the settings drill — context-aware: at the org (`~`) it lists the
 * org sections; inside a project (`/{org}/{project}/settings`) it lists only the
 * project-scoped sections and links to the project's settings paths. */
export function SettingsNav() {
	const pathname = usePathname();
	const orgSlug = useActiveOrgSlug();
	const scope = settingsScope(pathname) ?? { kind: "org" as const };
	const items = settingsNavItemsForScope(scope.kind);

	return (
		<nav className="space-y-1">
			{items.map((item) => {
				const href =
					scope.kind === "project"
						? projectSettingsHref(orgSlug, scope.projectSlug, item.sub)
						: globalHref(orgSlug, `settings/${item.sub}`);
				const active = pathname === href || pathname.startsWith(`${href}/`);
				return (
					<Link
						key={item.sub}
						href={href}
						className={cn(
							"flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
							active
								? "bg-muted/80 text-foreground"
								: "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
						)}
					>
						<item.icon className="h-4 w-4 shrink-0" />
						<span className="flex-1 truncate">{item.label}</span>
					</Link>
				);
			})}
		</nav>
	);
}
