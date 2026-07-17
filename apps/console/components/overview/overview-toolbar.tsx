"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Overview toolbar — the console filter standard's visual grammar (lib/query/README.md),
// in its URL→RSC form: FilterSearch + the shared CloudFilter + a Repository FacetFilter +
// the mono Reset, then a sort segmented control + card/table view toggle + a Create menu.
// All state is owned by the page (URL search params) — the standard's blessed URL→RSC
// variant — so this component is presentational and only emits `onChange`.

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Activity, ArrowDownAZ, GitBranch, Plus } from "lucide-react";
import { Button } from "@repo/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import { FacetFilter } from "@repo/ui/facet-filter";
import { FilterBar, FilterBarReset } from "@repo/ui/filter-bar";
import { FilterSearch } from "@repo/ui/filter-search";
import { PROVIDER_LABELS, type Provider } from "@repo/ui/provider-icon";
import { cn } from "@repo/ui/utils";
import { ViewToggle } from "@repo/ui/view-toggle";
import type { ProjectListResult } from "@/app/server/actions/projects";
import { getCollaborationAccess } from "@/app/server/actions/billing";
import { CloudFilter } from "@/components/filters/cloud-filter";
import { InviteMemberDialog } from "@/components/settings/members/invite-member-dialog";
import { UpgradeDialog } from "@/components/settings/upgrade/upgrade-dialog";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { globalHref } from "@/lib/routing";
import type { OverviewState } from "@/app/(private)/[org]/overview-client";

/** Human label for a cloud provider slug (shared vocabulary, uppercase fallback). */
function providerLabel(p: string): string {
	return PROVIDER_LABELS[p as Provider] ?? p.toUpperCase();
}

/** The filter dims Reset clears (view + sort are not filters, so they don't count). */
const FILTER_DEFAULTS = { q: "", clouds: [] as string[], repos: [] as string[] };

export function OverviewToolbar({
	orgSlug,
	state,
	facets,
	onChange,
}: {
	orgSlug: string;
	state: OverviewState;
	facets: ProjectListResult["facets"];
	onChange: (next: Partial<OverviewState>) => void;
}) {
	// Local, immediate draft for the search box; the URL (server query) updates on a debounce.
	const [draft, setDraft] = useState(state.q);
	// Adopt an external change to the query (e.g. a Reset, or navigation) into the draft —
	// React's "adjust state during render" pattern, so it stays in sync without an effect.
	const [syncedQ, setSyncedQ] = useState(state.q);
	if (state.q !== syncedQ) {
		setSyncedQ(state.q);
		setDraft(state.q);
	}
	useEffect(() => {
		if (draft === state.q) return;
		const id = setTimeout(() => onChange({ q: draft }), 300);
		return () => clearTimeout(id);
	}, [draft, state.q, onChange]);

	const cloudOptions = facets.clouds.map((c) => ({
		value: c.value,
		label: providerLabel(c.value),
		count: c.count,
	}));
	const repoOptions = facets.repos.map((r) => ({
		value: r.url,
		label: r.label,
		hint: String(r.count),
	}));

	return (
		<FilterBar
			end={
				<div className="flex items-center gap-2.5">
					<SortToggle
						value={state.sort}
						onChange={(sort) => onChange({ sort })}
					/>
					<ViewToggle value={state.view} onChange={(view) => onChange({ view })} />
					<CreateMenu orgSlug={orgSlug} />
				</div>
			}
		>
			<FilterSearch
				value={draft}
				onChange={setDraft}
				placeholder="Search projects…"
				ariaLabel="Search projects"
				className="w-[220px] max-w-[360px] flex-1"
			/>
			<CloudFilter
				value={state.clouds}
				onChange={(next) => onChange({ clouds: next })}
				options={cloudOptions}
			/>
			<FacetFilter
				label="Repository"
				icon={GitBranch}
				options={repoOptions}
				value={state.repos}
				onChange={(next) => onChange({ repos: next })}
				searchPlaceholder="Search repositories…"
				emptyText="No repositories."
			/>
			<FilterBarReset
				count={countActiveFilters(
					{ q: state.q, clouds: state.clouds, repos: state.repos },
					FILTER_DEFAULTS,
				)}
				onReset={() =>
					onChange({ q: "", clouds: [], repos: [], sort: "activity" })
				}
			/>
		</FilterBar>
	);
}

/** A compact segmented control for the grid's sort order (Activity / Name). Presentational —
 * mirrors ViewToggle; sort is not a filter, so it lives beside the filter bar's Reset. */
function SortToggle({
	value,
	onChange,
}: {
	value: OverviewState["sort"];
	onChange: (value: OverviewState["sort"]) => void;
}) {
	const OPTIONS = [
		{ key: "activity", label: "Activity", Icon: Activity },
		{ key: "name", label: "Name", Icon: ArrowDownAZ },
	] as const;
	return (
		<div
			className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border/60 bg-muted/20 p-1"
			role="group"
			aria-label="Sort"
		>
			{OPTIONS.map(({ key, label, Icon }) => {
				const active = value === key;
				return (
					<button
						key={key}
						type="button"
						onClick={() => onChange(key)}
						aria-pressed={active}
						className={cn(
							"inline-flex h-7 items-center gap-1.5 rounded px-2 text-[12px] transition-colors",
							active
								? "bg-background text-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						<Icon className="size-3.5" />
						{label}
					</button>
				);
			})}
		</div>
	);
}

/** "Create" menu — three plain actions: Project, Cloud, Org member. */
function CreateMenu({ orgSlug }: { orgSlug: string }) {
	const router = useRouter();
	// Invite is gated (card-backed/paid org): open the invite dialog when allowed, else the
	// upsell — mirroring the members table. Dialogs render outside the menu so they survive it
	// closing.
	const [inviteOpen, setInviteOpen] = useState(false);
	const [upsellOpen, setUpsellOpen] = useState(false);
	const [canInvite, setCanInvite] = useState(false);

	useEffect(() => {
		let alive = true;
		getCollaborationAccess()
			.then((a) => alive && setCanInvite(a.canInvite))
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button size="default" className="gap-1.5">
						<Plus className="h-4 w-4" />
						Create
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-44">
					<DropdownMenuLabel className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
						Create
					</DropdownMenuLabel>
					<DropdownMenuItem
						onSelect={() => router.push(globalHref(orgSlug, "new"))}
					>
						Project
					</DropdownMenuItem>
					<DropdownMenuItem
						onSelect={() =>
							router.push(`${globalHref(orgSlug, "connectors")}?type=cloud`)
						}
					>
						Cloud
					</DropdownMenuItem>
					<DropdownMenuItem
						onSelect={() =>
							canInvite ? setInviteOpen(true) : setUpsellOpen(true)
						}
					>
						Org member
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			{/* Controlled, trigger-less — opened from the "Org member" item above. */}
			<InviteMemberDialog open={inviteOpen} onOpenChange={setInviteOpen} />
			<UpgradeDialog
				feature="invite"
				open={upsellOpen}
				onOpenChange={setUpsellOpen}
			/>
		</>
	);
}
