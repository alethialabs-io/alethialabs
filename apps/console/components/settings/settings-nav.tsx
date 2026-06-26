"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	CreditCard,
	Gauge,
	KeyRound,
	Lock,
	ScrollText,
	Settings2,
	ShieldCheck,
	Users,
	UsersRound,
	type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
	useActiveOrgSlug,
	useWorkspaceStore,
} from "@/lib/stores/use-workspace-store";
import { globalHref } from "@/lib/routing";
import type { Entitlements } from "@/lib/authz/types";
import { cn } from "@repo/ui/utils";

interface NavItem {
	label: string;
	href: string;
	icon: LucideIcon;
	/** Entitlement that unlocks the section; omitted = always available (community-real). */
	entitlement?: keyof Entitlements;
}

// The settings information architecture — one flat list. Roles is community-real
// (built-in roles come from the registry); the rest are Enterprise org-scoped surfaces.
// Billing is always visible — it's how an unentitled user upgrades. C2c: each `sub`
// is resolved under the active org → `/{org}/~/settings/{sub}`.
const ITEMS: (Omit<NavItem, "href"> & { sub: string })[] = [
	{ label: "General", sub: "general", icon: Settings2, entitlement: "organizations" },
	{ label: "Members", sub: "members", icon: Users, entitlement: "organizations" },
	{ label: "Teams", sub: "teams", icon: UsersRound, entitlement: "organizations" },
	{ label: "Roles", sub: "roles", icon: ShieldCheck },
	{ label: "Access", sub: "access", icon: Lock, entitlement: "customRoles" },
	{ label: "Single Sign-On", sub: "sso", icon: KeyRound, entitlement: "sso" },
	{ label: "Audit Log", sub: "audit", icon: ScrollText, entitlement: "auditExport" },
	{ label: "Billing", sub: "billing", icon: CreditCard },
	{ label: "Usage", sub: "usage", icon: Gauge },
];

/** Left section-nav for the settings two-pane shell. */
export function SettingsNav() {
	const pathname = usePathname();
	const orgSlug = useActiveOrgSlug();
	const entitlements = useWorkspaceStore((s) => s.entitlements);

	return (
		<nav className="space-y-1">
			{ITEMS.map((item) => {
				const href = globalHref(orgSlug, `settings/${item.sub}`);
				const active = pathname === href || pathname.startsWith(`${href}/`);
				// A subtle lock when the section needs an entitlement the workspace lacks.
				const locked =
					item.entitlement != null && !(entitlements?.[item.entitlement] ?? false);
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
						{locked && <Lock className="h-3 w-3 shrink-0 text-muted-foreground/60" />}
					</Link>
				);
			})}
		</nav>
	);
}
