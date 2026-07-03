// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure data for the settings information architecture. Kept out of the JSX component
// (settings-nav.tsx) so non-UI consumers — e.g. the command palette — can import the
// list without dragging a "use client" component module into their graph.

import {
	CreditCard,
	KeyRound,
	Network,
	ScrollText,
	Settings2,
	ShieldCheck,
	Users,
	UsersRound,
	type LucideIcon,
} from "lucide-react";

/** Which scope(s) a settings section appears in: the org (`~`) and/or inside a project. */
export type SettingsScopeKind = "org" | "project";

/** One settings section. `sub` resolves under the active scope →
 * `/{org}/~/settings/{sub}` (org) or `/{org}/{project}/settings/{sub}` (project). */
export interface SettingsNavItem {
	label: string;
	sub: string;
	icon: LucideIcon;
	/** Scopes this section is shown in. Org-only surfaces (billing, SSO, …) omit "project". */
	scopes: SettingsScopeKind[];
}

// One flat list, in display order. Every section is always visible within its scope —
// plan-gated surfaces (Teams, Roles, Access, SSO) render their own in-page upsell when
// locked rather than hiding behind a wall, so the nav carries no lock state. Usage moved
// out to a top-level route; Activity (the former Audit Log) is available on every plan.
// Project scope currently exposes only Activity (this project's events); General/Access/
// Members gain "project" as those project-scoped surfaces land.
export const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
	{ label: "General", sub: "general", icon: Settings2, scopes: ["org"] },
	{ label: "Billing", sub: "billing", icon: CreditCard, scopes: ["org"] },
	{ label: "Members", sub: "members", icon: Users, scopes: ["org"] },
	{ label: "Teams", sub: "teams", icon: UsersRound, scopes: ["org"] },
	{ label: "Roles", sub: "roles", icon: ShieldCheck, scopes: ["org"] },
	{ label: "Access", sub: "access", icon: Network, scopes: ["org"] },
	{ label: "Single Sign-On", sub: "sso", icon: KeyRound, scopes: ["org"] },
	{ label: "Activity", sub: "activity", icon: ScrollText, scopes: ["org", "project"] },
];

/** The sections visible in a given scope, in display order. */
export function settingsNavItemsForScope(
	scope: SettingsScopeKind,
): SettingsNavItem[] {
	return SETTINGS_NAV_ITEMS.filter((item) => item.scopes.includes(scope));
}
