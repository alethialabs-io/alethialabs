"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The global command palette behind the sidebar "Find…" box. Opens on click or the
// ⌘K shortcut and searches the starting points of the common actions (create a project,
// connect a cloud account, invite a member), navigable pages and live resources (projects,
// jobs) pulled from the same stores the rest of the shell uses. Selecting an entry navigates
// and closes. Mounted once by the AppShell.

import { Box, ClipboardList, Cloud, type LucideIcon, Plus, UserPlus } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useMemo } from "react";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@repo/ui/command";
import { groupResults, useCommandSearch } from "@repo/ui/command-search";
import { CLOUD_ACCOUNT, ORGANIZATION, PROJECT } from "@/lib/copy/vocabulary";
import { JOB_TYPES } from "@/lib/jobs/format";
import { settingsNavItemsForScope } from "@/components/settings/settings-nav-items";
import {
	buildDrills,
	buildSidebarNav,
	projectScope,
} from "@/components/shell/nav-config";
import { globalHref, projectHref, projectSettingsHref } from "@/lib/routing";
import { SHORTCUT_PALETTE_TOGGLE } from "@/lib/shortcuts/registry";
import { useShortcut } from "@/lib/shortcuts/use-shortcut";
import { useCommandPalette } from "@/lib/stores/use-command-palette";
import { useRecentJobsQuery } from "@/lib/query/use-jobs-query";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { useProjectsQuery } from "@/lib/query/use-projects-query";

/** The palette's four groups, in the order they list for an empty search. */
type PaletteGroup = "Actions" | "Pages" | "Projects" | "Jobs";

/** A flat, navigable palette entry. */
export interface PaletteEntry {
	group: PaletteGroup;
	label: string;
	href: string;
	icon: LucideIcon;
	/** Secondary muted text shown on the right (e.g. a job id). */
	hint?: string;
}

/**
 * The palette's Actions group: where each common action STARTS. Each entry navigates to the page
 * that owns the action, which decides there whether the viewer may take it and says why not — the
 * palette holds no permission of its own to get wrong (R6 S-07).
 */
export function paletteActions(orgSlug: string): PaletteEntry[] {
	return [
		{ group: "Actions", label: `Create a ${PROJECT.one}`, href: globalHref(orgSlug, "new"), icon: Plus },
		{
			group: "Actions",
			label: `Connect a ${CLOUD_ACCOUNT.one}`,
			href: `${globalHref(orgSlug, "connectors")}?type=cloud`,
			icon: Cloud,
		},
		{
			group: "Actions",
			label: `Invite an ${ORGANIZATION.one} member`,
			href: globalHref(orgSlug, "settings/members"),
			icon: UserPlus,
		},
	];
}

/** A job's palette label: its type, and the project it ran for when it has one. */
export function paletteJobLabel(typeLabel: string, projectName: string | null | undefined): string {
	return projectName ? `${typeLabel} · ${projectName}` : typeLabel;
}

/**
 * The global command palette. Reads nav + live resources, renders a searchable
 * dialog, and routes on select.
 */
export function CommandPalette({ selfRunners = false }: { selfRunners?: boolean }) {
	const router = useRouter();
	const pathname = usePathname();
	const orgSlug = useActiveOrgSlug();
	const open = useCommandPalette((s) => s.open);
	const setOpen = useCommandPalette((s) => s.setOpen);
	const toggle = useCommandPalette((s) => s.toggle);
	const { data: projects = [] } = useProjectsQuery();
	const { data: jobs = [] } = useRecentJobsQuery();

	// ⌘K / Ctrl+K, from anywhere including a field; the chord is the registry's.
	useShortcut(SHORTCUT_PALETTE_TOGGLE, toggle);

	// Navigable pages: sidebar groups + drill sub-pages + settings sub-pages, deduped.
	const pages = useMemo<PaletteEntry[]>(() => {
		const out: PaletteEntry[] = [];
		const seen = new Set<string>();
		const push = (label: string, href: string, icon: LucideIcon) => {
			if (seen.has(href)) return;
			seen.add(href);
			out.push({ group: "Pages", label, href, icon });
		};

		const groups = buildSidebarNav(orgSlug, { selfRunners });
		for (const item of [...groups.top, ...groups.connect, ...groups.pinned]) {
			const href = item.href ?? item.anchor;
			if (!item.disabled && href) push(item.label, href, item.icon);
		}

		const drills = buildDrills(orgSlug);
		for (const drill of Object.values(drills)) {
			for (const item of drill.items ?? []) {
				if (!item.disabled && item.href) push(item.label, item.href, item.icon);
			}
		}

		for (const item of settingsNavItemsForScope("org")) {
			push(
				`Settings / ${item.label}`,
				globalHref(orgSlug, `settings/${item.sub}`),
				item.icon,
			);
		}

		const project = projectScope(pathname);
		if (project) {
			for (const item of settingsNavItemsForScope("project")) {
				push(
					`Project settings / ${item.label}`,
					projectSettingsHref(orgSlug, project.projectSlug, item.sub),
					item.icon,
				);
			}
		}

		return out;
	}, [orgSlug, pathname, selfRunners]);

	// Live projects (projects), flat under the org.
	const projectEntries = useMemo<PaletteEntry[]>(() => {
		const out: PaletteEntry[] = [];
		for (const p of projects) {
			if (!p.slug) continue;
			out.push({
				group: "Projects",
				label: p.project_name,
				href: projectHref(orgSlug, p.slug),
				icon: Box,
			});
		}
		return out;
	}, [projects, orgSlug]);

	// Live jobs, named by what ran and where — "Deploy · Shop" — so two deploys are told apart by
	// their project rather than only by an id fragment. The id stays as the hint.
	const jobEntries = useMemo<PaletteEntry[]>(() => {
		return jobs.map((j) => ({
			group: "Jobs",
			label: paletteJobLabel(JOB_TYPES[j.job_type]?.label ?? String(j.job_type), j.project_name),
			href: globalHref(orgSlug, `jobs/${j.id}`),
			icon: ClipboardList,
			hint: j.id.slice(0, 8),
		}));
	}, [jobs, orgSlug]);

	const actions = useMemo(() => paletteActions(orgSlug), [orgSlug]);
	const entries = useMemo(
		() => [...actions, ...pages, ...projectEntries, ...jobEntries],
		[actions, pages, projectEntries, jobEntries],
	);
	// Ranked by the shared ranker (exact > prefix > word start > substring), so the best match is
	// listed first and its group leads.
	const { search, onSearchChange, results } = useCommandSearch(
		entries,
		paletteSearchText,
		{ open },
	);
	const groups = groupResults(results, (e) => e.group);

	/** Routes to an entry and dismisses the palette. */
	const go = (href: string) => {
		setOpen(false);
		router.push(href);
	};

	return (
		<CommandDialog
			open={open}
			onOpenChange={setOpen}
			search={search}
			onSearchChange={onSearchChange}
			filteredItems={groups.flatMap((g) => g.items)}
		>
			<CommandInput placeholder="Search actions, pages, projects, jobs…" />
			<CommandList>
				<CommandEmpty>No results found.</CommandEmpty>
				{groups.map(({ group, items }) => (
					<CommandGroup key={group} heading={group}>
						{items.map((e) => (
							<CommandItem key={e.href} onSelect={() => go(e.href)}>
								<e.icon />
								<span>{e.label}</span>
								{e.hint && (
									<span className="ml-auto font-mono text-xs text-muted-foreground">
										{e.hint}
									</span>
								)}
							</CommandItem>
						))}
					</CommandGroup>
				))}
			</CommandList>
		</CommandDialog>
	);
}

/** An entry's search text: its label, its hint (a job id) and its href, as cmdk matched them. */
function paletteSearchText(e: PaletteEntry): string {
	return `${e.label} ${e.hint ?? ""} ${e.href}`;
}
