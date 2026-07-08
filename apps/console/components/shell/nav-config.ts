// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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
	Gauge,
	Layers,
	LayoutDashboard,
	LifeBuoy,
	Server,
	Settings,
	ShieldAlert,
	ShieldCheck,
	Waypoints,
	Webhook,
	Workflow,
} from "lucide-react";
import { globalHref, orgHref, projectGlobalHref } from "@/lib/routing";

/** A sidebar section that slides in as a nested sub-sidebar. */
export type DrillId = "alerts" | "settings";

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
	/** In-page section anchor id (e.g. "channels"): scroll to it instead of route-navigating. */
	scrollId?: string;
	badge?: NavBadge;
	/** A surface that does not exist yet — rendered visible but non-interactive. */
	disabled?: boolean;
	/** Active only on the exact org overview (`/{org}`). */
	exact?: boolean;
	/** Active only on the exact project overview (`/{org}/{project}`). */
	exactProject?: boolean;
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

/** Capabilities that toggle conditional nav items on/off. Derived server-side and threaded
 * through the shell so the sidebar only advertises surfaces that are real for this org. */
export interface NavCapabilities {
	/** The org runs its own (`operator = 'self'`) runners — only then is Runners a customer
	 * surface. Managed warm pools are internal (support-admin), so the item stays hidden. */
	selfRunners?: boolean;
}

/** Builds the three main-view nav groups for an org slug. Runners is gated behind
 * `capabilities.selfRunners`; the `/{org}/~/runners` route itself stays reachable by deep link. */
export function buildSidebarNav(
	orgSlug: string,
	capabilities: NavCapabilities = {},
): SidebarNavGroups {
	return {
		top: [
			{ label: "Overview", icon: LayoutDashboard, href: orgHref(orgSlug), exact: true },
			{ label: "Clusters", icon: Server, sub: "clusters", href: globalHref(orgSlug, "clusters") },
			{ label: "Jobs", icon: ClipboardList, sub: "jobs", href: globalHref(orgSlug, "jobs") },
			{ label: "Evidence", icon: ShieldCheck, sub: "evidence", href: globalHref(orgSlug, "evidence") },
		],
		connect: [
			{ label: "Connectors", icon: Blocks, sub: "connectors", href: globalHref(orgSlug, "connectors") },
			{ label: "Alerts", icon: Bell, drill: "alerts", anchor: globalHref(orgSlug, "alerts") },
			// Runners is a self-operator surface only — appended when the org runs its own runners.
			...(capabilities.selfRunners
				? [
						{
							label: "Runners",
							icon: Workflow,
							sub: "runners",
							href: globalHref(orgSlug, "runners"),
						} satisfies NavItem,
					]
				: []),
		],
		pinned: [
			{ label: "Usage", icon: Gauge, sub: "usage", href: globalHref(orgSlug, "usage") },
			{ label: "Support", icon: LifeBuoy, sub: "support", href: globalHref(orgSlug, "support") },
			{ label: "Settings", icon: Settings, drill: "settings", anchor: globalHref(orgSlug, "settings") },
		],
	};
}

/** Builds the main-view nav groups scoped to a single project. Mirrors `buildSidebarNav` but
 * every link targets `/{org}/{project}/…` so the sidebar follows the project drilldown. Only the
 * project-relevant surfaces appear; inherently org-level concerns (Runners, Connectors, Agent,
 * Alerts, Billing/Members/…) live at the org `~` scope, reached via the org switcher. */
export function buildProjectSidebarNav(
	orgSlug: string,
	projectSlug: string,
): SidebarNavGroups {
	const sub = (s: string) => projectGlobalHref(orgSlug, projectSlug, s);
	// A project is a workspace with exactly these six views — all top-aligned, each rendered in
	// place of the canvas. Architecture is the design surface (the bare project redirects to it).
	return {
		top: [
			{ label: "Architecture", icon: Waypoints, sub: "architecture", href: sub("architecture") },
			{ label: "Environments", icon: Layers, sub: "environments", href: sub("environments") },
			{ label: "Jobs", icon: ClipboardList, sub: "jobs", href: sub("jobs") },
			{ label: "Clusters", icon: Server, sub: "clusters", href: sub("clusters") },
			{ label: "Usage", icon: Gauge, sub: "usage", href: sub("usage") },
			{ label: "Settings", icon: Settings, sub: "settings", href: sub("settings") },
		],
		connect: [],
		pinned: [],
	};
}

/** Builds the drill-in sub-view definitions for an org slug. */
export function buildDrills(orgSlug: string): Record<DrillId, DrillDef> {
	return {
		alerts: {
			id: "alerts",
			title: "Alerts",
			routeOwned: true,
			// Single-page hub: each item anchor-scrolls to its stacked section. The href
			// carries the hash so cross-page clicks land scrolled to the right section.
			items: [
				{
					label: "Policies",
					icon: ShieldAlert,
					scrollId: "policies",
					href: `${globalHref(orgSlug, "alerts")}#policies`,
				},
				{
					label: "Channels",
					icon: Webhook,
					scrollId: "channels",
					href: `${globalHref(orgSlug, "alerts")}#channels`,
				},
				{
					label: "Activity",
					icon: Activity,
					scrollId: "activity",
					href: `${globalHref(orgSlug, "alerts")}#activity`,
				},
			],
		},
		settings: {
			id: "settings",
			title: "Settings",
			routeOwned: true,
		},
	};
}

/** Builds the drill-in sub-views scoped to a single project. Settings reuses the scope-aware
 * `<SettingsNav/>`. Alerts is org-only, so it has no project variant. */
export function buildProjectDrills(
	_orgSlug: string,
	_projectSlug: string,
): Record<DrillId, DrillDef> {
	return {
		// Org-only — never rendered in project scope, but the map shape requires an entry.
		alerts: { id: "alerts", title: "Alerts", routeOwned: true, items: [] },
		settings: { id: "settings", title: "Settings", routeOwned: true },
	};
}

/** The org-global sub-page under `/{org}/~/{sub}` (e.g. "settings"), or null. */
export function globalSub(pathname: string): string | null {
	const segs = pathname.split("/").filter(Boolean);
	return segs[1] === "~" ? segs[2] ?? null : null;
}

/** The active settings scope from a pathname: org (`/{org}/~/settings/*`), a specific project
 * (`/{org}/{project}/settings/*`), or null when the path isn't a settings page. */
export function settingsScope(
	pathname: string,
): { kind: "org" } | { kind: "project"; projectSlug: string } | null {
	const segs = pathname.split("/").filter(Boolean); // [org, ~|project, "settings", sub?]
	if (segs[2] !== "settings") return null;
	if (segs[1] === "~") return { kind: "org" };
	return { kind: "project", projectSlug: segs[1] };
}

/** The project drilldown scope from a pathname: a specific project when the second segment is a
 * real project slug (`/{org}/{project}[/…]`), or null at the org overview (`/{org}`) and the
 * org-global scope (`/{org}/~/…`). Drives which sidebar (org vs project) the shell renders. */
export function projectScope(
	pathname: string,
): { projectSlug: string } | null {
	const segs = pathname.split("/").filter(Boolean); // [org, ~|project, sub?]
	if (segs.length < 2 || segs[1] === "~") return null;
	return { projectSlug: segs[1] };
}

/** The project sub-page under `/{org}/{project}/{sub}` (e.g. "jobs"), or null when not in a
 * project scope. The project analogue of `globalSub`. */
export function projectSub(pathname: string): string | null {
	return projectScope(pathname) ? pathname.split("/").filter(Boolean)[2] ?? null : null;
}

/** True when the path is the bare org overview `/{org}` (the projects grid). */
export function isOverviewPath(pathname: string): boolean {
	const segs = pathname.split("/").filter(Boolean);
	return segs.length === 1 && segs[0] !== "dashboard";
}

/** True when the path is the bare project overview `/{org}/{project}` (no sub-page). */
export function isProjectOverviewPath(pathname: string): boolean {
	const segs = pathname.split("/").filter(Boolean);
	return segs.length === 2 && segs[1] !== "~";
}

/** Whether a nav item is the active route — structural, independent of the resolved org slug.
 * Matches in both scopes: `sub` against the org-global sub (`/{org}/~/{sub}`) or the project sub
 * (`/{org}/{project}/{sub}`), whichever the pathname is in. */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
	if (item.exact) return isOverviewPath(pathname);
	if (item.exactProject) return isProjectOverviewPath(pathname);
	if (item.sub) return (globalSub(pathname) ?? projectSub(pathname)) === item.sub;
	return false;
}

/** The drill that owns the current route (so it auto-opens on deep-link/refresh), or null.
 * Settings is route-owned at BOTH scopes (org `~/settings` and project `{project}/settings`). */
export function routeOwnedDrill(pathname: string): DrillId | null {
	if (settingsScope(pathname)) return "settings";
	if (globalSub(pathname) === "alerts") return "alerts";
	return null;
}
