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
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";
import type { Entitlements } from "@/lib/authz/types";
import { cn } from "@/lib/utils";

interface NavItem {
	label: string;
	href: string;
	icon: LucideIcon;
	/** Entitlement that unlocks the section; omitted = always available (community-real). */
	entitlement?: keyof Entitlements;
}

const BASE = "/dashboard/settings";

// The settings information architecture — one flat list. Roles is community-real
// (built-in roles come from the registry); the rest are Enterprise org-scoped surfaces.
// Billing is always visible — it's how an unentitled user upgrades.
const ITEMS: NavItem[] = [
	{ label: "General", href: `${BASE}/general`, icon: Settings2, entitlement: "organizations" },
	{ label: "Members", href: `${BASE}/members`, icon: Users, entitlement: "organizations" },
	{ label: "Teams", href: `${BASE}/teams`, icon: UsersRound, entitlement: "organizations" },
	{ label: "Roles", href: `${BASE}/roles`, icon: ShieldCheck },
	{ label: "Access", href: `${BASE}/access`, icon: Lock, entitlement: "customRoles" },
	{ label: "Single Sign-On", href: `${BASE}/sso`, icon: KeyRound, entitlement: "sso" },
	{ label: "Audit Log", href: `${BASE}/audit`, icon: ScrollText, entitlement: "auditExport" },
	{ label: "Billing", href: `${BASE}/billing`, icon: CreditCard },
	{ label: "AI Usage", href: `${BASE}/usage`, icon: Gauge },
];

/** Left section-nav for the settings two-pane shell. */
export function SettingsNav() {
	const pathname = usePathname();
	const entitlements = useWorkspaceStore((s) => s.entitlements);

	return (
		<nav className="space-y-1">
			{ITEMS.map((item) => {
				const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
				// A subtle lock when the section needs an entitlement the workspace lacks.
				const locked =
					item.entitlement != null && !(entitlements?.[item.entitlement] ?? false);
				return (
					<Link
						key={item.href}
						href={item.href}
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
