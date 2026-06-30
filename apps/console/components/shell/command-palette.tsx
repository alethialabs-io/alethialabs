"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The global command palette behind the sidebar "Find…" box. Opens on click or the
// ⌘K / F shortcut and searches navigable pages plus live resources (projects, jobs)
// pulled from the same stores the rest of the shell uses. Selecting an entry navigates
// and closes. Mounted once by the AppShell.

import { Box, ClipboardList, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@repo/ui/command";
import { JOB_TYPES } from "@/components/jobs/columns";
import { SETTINGS_NAV_ITEMS } from "@/components/settings/settings-nav-items";
import { buildDrills, buildSidebarNav } from "@/components/shell/nav-config";
import { globalHref } from "@/lib/routing";
import { useCommandPalette } from "@/lib/stores/use-command-palette";
import { useJobsQuery } from "@/lib/query/use-jobs-query";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { useProjectsQuery } from "@/lib/query/use-projects-query";
import { projectHref } from "@/lib/routing";

/** A flat, navigable palette entry. */
interface PaletteEntry {
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
export function CommandPalette() {
	const router = useRouter();
	const orgSlug = useActiveOrgSlug();
	const open = useCommandPalette((s) => s.open);
	const setOpen = useCommandPalette((s) => s.setOpen);
	const toggle = useCommandPalette((s) => s.toggle);
	const { data: projects = [] } = useProjectsQuery();
	const { data: jobs = [] } = useJobsQuery();

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
			out.push({ label, href, icon });
		};

		const groups = buildSidebarNav(orgSlug);
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

		for (const item of SETTINGS_NAV_ITEMS) {
			push(
				`Settings / ${item.label}`,
				globalHref(orgSlug, `settings/${item.sub}`),
				item.icon,
			);
		}

		return out;
	}, [orgSlug]);

	// Live projects (projects), flat under the org.
	const projectEntries = useMemo<PaletteEntry[]>(() => {
		const out: PaletteEntry[] = [];
		for (const p of projects) {
			if (!p.slug) continue;
			out.push({
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
			label: JOB_TYPES[j.job_type]?.label ?? String(j.job_type),
			href: globalHref(orgSlug, `jobs/${j.id}`),
			icon: ClipboardList,
			hint: j.id.slice(0, 8),
		}));
	}, [jobs, orgSlug]);

	/** Routes to an entry and dismisses the palette. */
	const go = (href: string) => {
		setOpen(false);
		router.push(href);
	};

	return (
		<CommandDialog open={open} onOpenChange={setOpen}>
			<CommandInput placeholder="Search pages, projects, jobs…" />
			<CommandList>
				<CommandEmpty>No results found.</CommandEmpty>

				<CommandGroup heading="Pages">
					{pages.map((p) => (
						<CommandItem
							key={p.href}
							value={`${p.label} ${p.href}`}
							onSelect={() => go(p.href)}
						>
							<p.icon />
							<span>{p.label}</span>
						</CommandItem>
					))}
				</CommandGroup>

				{projectEntries.length > 0 && (
					<CommandGroup heading="Projects">
						{projectEntries.map((p) => (
							<CommandItem
								key={p.href}
								value={`${p.label} ${p.href}`}
								onSelect={() => go(p.href)}
							>
								<p.icon />
								<span>{p.label}</span>
							</CommandItem>
						))}
					</CommandGroup>
				)}

				{jobEntries.length > 0 && (
					<CommandGroup heading="Jobs">
						{jobEntries.map((j) => (
							<CommandItem
								key={j.href}
								value={`${j.label} ${j.hint ?? ""} ${j.href}`}
								onSelect={() => go(j.href)}
							>
								<j.icon />
								<span>{j.label}</span>
								{j.hint && (
									<span className="ml-auto font-mono text-xs text-muted-foreground">
										{j.hint}
									</span>
								)}
							</CommandItem>
						))}
					</CommandGroup>
				)}
			</CommandList>
		</CommandDialog>
	);
}
