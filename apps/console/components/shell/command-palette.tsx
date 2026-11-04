"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The global command palette behind the sidebar "Find…" box. Opens on click or the
// ⌘K / F shortcut and searches navigable pages plus live resources (projects, jobs)
// pulled from the same stores the rest of the shell uses. Selecting an entry navigates
// and closes. Mounted once by the AppShell.

import { Box, ClipboardList, type LucideIcon } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@repo/ui/command";
import { groupResults, useCommandSearch } from "@repo/ui/command-search";
import { JOB_TYPES } from "@/lib/jobs/format";
import { settingsNavItemsForScope } from "@/components/settings/settings-nav-items";
import {
	buildDrills,
	buildSidebarNav,
	projectScope,
} from "@/components/shell/nav-config";
import { globalHref, projectHref, projectSettingsHref } from "@/lib/routing";
import { useCommandPalette } from "@/lib/stores/use-command-palette";
import { useRecentJobsQuery } from "@/lib/query/use-jobs-query";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { useProjectsQuery } from "@/lib/query/use-projects-query";

/** The palette's three groups, in the order they list for an empty search. */
type PaletteGroup = "Pages" | "Projects" | "Jobs";

/** A flat, navigable palette entry. */
interface PaletteEntry {
	group: PaletteGroup;
	label: string;
	href: string;
	icon: LucideIcon;
	/** Secondary muted text shown on the right (e.g. a job id). */
	hint?: string;
}

/** True when a keystroke originates from a text-entry surface (so F passes through). */
function isTypingTarget(t: EventTarget | null): boolean {
	if (!(t instanceof HTMLElement)) return false;
	const tag = t.tagName;
	return (
		tag === "INPUT" ||
		tag === "TEXTAREA" ||
		tag === "SELECT" ||
		t.isContentEditable
	);
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

	// ⌘K / Ctrl+K anywhere; bare F only when not typing into a field.
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				toggle();
				return;
			}
			if (
				e.key.toLowerCase() === "f" &&
				!e.metaKey &&
				!e.ctrlKey &&
				!e.altKey &&
				!isTypingTarget(e.target)
			) {
				e.preventDefault();
				toggle();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [toggle]);

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

	// Live jobs.
	const jobEntries = useMemo<PaletteEntry[]>(() => {
		return jobs.map((j) => ({
			group: "Jobs",
			label: JOB_TYPES[j.job_type]?.label ?? String(j.job_type),
			href: globalHref(orgSlug, `jobs/${j.id}`),
			icon: ClipboardList,
			hint: j.id.slice(0, 8),
		}));
	}, [jobs, orgSlug]);

	const entries = useMemo(
		() => [...pages, ...projectEntries, ...jobEntries],
		[pages, projectEntries, jobEntries],
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
			<CommandInput placeholder="Search pages, projects, jobs…" />
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
