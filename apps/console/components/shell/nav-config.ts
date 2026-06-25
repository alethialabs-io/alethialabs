// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The sidebar navigation model for the Vercel-style app shell. Pure data + structural
// route matchers (independent of the resolved org slug), so the sidebar can derive its
// drill state and active item from `usePathname()` alone — deep links and refreshes land
// in the right sub-view. Surfaces we have not built yet are marked `disabled` (rendered
// visible but non-interactive); the only real drill-in with sub-pages is Settings.

import type { LucideIcon } from "lucide-react";
import {
	Activity,
	Bell,
	Blocks,
	ClipboardList,
	Eye,
	FlaskConical,
	Gauge,
	GitBranch,
	Layers,
	LayoutDashboard,
	LifeBuoy,
	LineChart,
	Puzzle,
	ScrollText,
	Server,
	Settings,
	ShieldAlert,
	Sparkles,
	Waypoints,
	Webhook,
	Workflow,
} from "lucide-react";
import { globalHref, orgHref } from "@/lib/routing";

/** A sidebar section that slides in as a nested sub-sidebar. */
export type DrillId = "observability" | "runners" | "alerts" | "settings";

/** A small uppercase tag on a nav item. */
export interface NavBadge {
	text: string;
	tone: "beta" | "soon";
}

/** One sidebar row — a link, a drill trigger, or a not-yet-built stub. */
export interface NavItem {
	label: string;
	icon: LucideIcon;
	/** Org-global sub-page key (`/{org}/~/{sub}`) — drives active matching. */
	sub?: string;
	/** Navigation target (Overview uses `orgHref`, global pages use `globalHref`). */
	href?: string;
	/** Opens a drill-in sub-view instead of navigating. */
	drill?: DrillId;
	/** Route-owned drills navigate here on click, so the route itself opens the drill. */
	anchor?: string;
	badge?: NavBadge;
	/** A surface that does not exist yet — rendered visible but non-interactive. */
	disabled?: boolean;
	/** Active only on the exact org overview (`/{org}`). */
	exact?: boolean;
}

/** The three groups of the main sidebar view. */
export interface SidebarNavGroups {
	top: NavItem[];
	connect: NavItem[];
	pinned: NavItem[];
}

/** A drill-in sub-view definition. */
export interface DrillDef {
	id: DrillId;
	title: string;
	/** Route-owned drills auto-open on their path; "back" then navigates to the overview. */
	routeOwned: boolean;
	/** Sub-nav items. Omitted for Settings, which renders `<SettingsNav/>` instead. */
	items?: NavItem[];
}

/** Builds the three main-view nav groups for an org slug. */
export function buildSidebarNav(orgSlug: string): SidebarNavGroups {
	return {
		top: [
			{ label: "Overview", icon: LayoutDashboard, href: orgHref(orgSlug), exact: true },
			{ label: "Clusters", icon: Server, sub: "clusters", href: globalHref(orgSlug, "clusters") },
			{ label: "Jobs", icon: ClipboardList, sub: "jobs", href: globalHref(orgSlug, "jobs") },
			{ label: "Observability", icon: Eye, drill: "observability" },
			{ label: "Runners", icon: Workflow, drill: "runners", anchor: globalHref(orgSlug, "runners") },
		],
		connect: [
			{ label: "Connectors", icon: Blocks, sub: "connectors", href: globalHref(orgSlug, "connectors") },
			{ label: "Alerts", icon: Bell, drill: "alerts", anchor: globalHref(orgSlug, "alerts") },
			{ label: "Integrations", icon: Puzzle, disabled: true, badge: { text: "Beta", tone: "beta" } },
			{ label: "Agent", icon: Sparkles, sub: "agent", href: globalHref(orgSlug, "agent") },
			{ label: "Sandboxes", icon: FlaskConical, disabled: true, badge: { text: "Soon", tone: "soon" } },
		],
		pinned: [
			{ label: "Usage", icon: Gauge, href: globalHref(orgSlug, "settings/usage") },
			{ label: "Support", icon: LifeBuoy, disabled: true, badge: { text: "Soon", tone: "soon" } },
			{ label: "Settings", icon: Settings, drill: "settings", anchor: globalHref(orgSlug, "settings") },
		],
	};
}

/** Builds the drill-in sub-view definitions for an org slug. */
export function buildDrills(orgSlug: string): Record<DrillId, DrillDef> {
	const soon: NavBadge = { text: "Soon", tone: "soon" };
	return {
		observability: {
			id: "observability",
			title: "Observability",
			routeOwned: false,
			items: [
				{ label: "Jobs", icon: ClipboardList, sub: "jobs", href: globalHref(orgSlug, "jobs") },
				{ label: "Logs", icon: ScrollText, disabled: true, badge: soon },
				{ label: "Metrics", icon: LineChart, disabled: true, badge: soon },
				{ label: "Traces", icon: Waypoints, disabled: true, badge: soon },
				{ label: "Activity", icon: Activity, disabled: true, badge: soon },
			],
		},
		runners: {
			id: "runners",
			title: "Runners",
			routeOwned: true,
			items: [
				{ label: "Fleet overview", icon: Workflow, sub: "runners", href: globalHref(orgSlug, "runners") },
				{ label: "Pools", icon: Layers, disabled: true, badge: soon },
				{ label: "Versions", icon: GitBranch, disabled: true, badge: soon },
				{ label: "Self-hosted", icon: Server, disabled: true, badge: soon },
			],
		},
		alerts: {
			id: "alerts",
			title: "Alerts",
			routeOwned: true,
			items: [
				{ label: "Policies", icon: ShieldAlert, sub: "alerts", href: globalHref(orgSlug, "alerts") },
				{ label: "Channels", icon: Webhook, disabled: true, badge: soon },
				{ label: "Activity", icon: Activity, disabled: true, badge: soon },
			],
		},
		settings: {
			id: "settings",
			title: "Settings",
			routeOwned: true,
		},
	};
}

/** The org-global sub-page under `/{org}/~/{sub}` (e.g. "settings"), or null. */
export function globalSub(pathname: string): string | null {
	const segs = pathname.split("/").filter(Boolean);
	return segs[1] === "~" ? segs[2] ?? null : null;
}

/** True when the path is the bare org overview `/{org}` (the zones grid). */
export function isOverviewPath(pathname: string): boolean {
	const segs = pathname.split("/").filter(Boolean);
	return segs.length === 1 && segs[0] !== "dashboard";
}

/** Whether a nav item is the active route — structural, independent of the resolved org slug. */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
	if (item.exact) return isOverviewPath(pathname);
	if (item.sub) return globalSub(pathname) === item.sub;
	return false;
}

/** The drill that owns the current route (so it auto-opens on deep-link/refresh), or null. */
export function routeOwnedDrill(pathname: string): DrillId | null {
	switch (globalSub(pathname)) {
		case "settings":
			return "settings";
		case "runners":
			return "runners";
		case "alerts":
			return "alerts";
		default:
			return null;
	}
}
