"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Overview toolbar — project search (debounced → URL), a two-level "Filter by / Sort by" popover
// (drill into a searchable Cloud or Repository selector), a card/table view toggle, and a "Create"
// menu. All state is owned by the page (URL search params); this component only emits changes.

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import {
	Activity,
	ChevronLeft,
	ChevronRight,
	Check,
	Cloud,
	GitBranch,
	Layers,
	Plus,
	Search,
	SlidersHorizontal,
} from "lucide-react";
import { Button } from "@repo/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import { Input } from "@repo/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/popover";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { ViewToggle } from "@repo/ui/view-toggle";
import type {
	ProjectListResult,
	ProjectRepoRef,
} from "@/app/server/actions/projects";
import { getCollaborationAccess } from "@/app/server/actions/billing";
import { InviteMemberDialog } from "@/components/settings/members/invite-member-dialog";
import { UpgradeDialog } from "@/components/settings/upgrade/upgrade-dialog";
import { globalHref } from "@/lib/routing";
import type { OverviewState } from "@/app/(private)/[org]/overview-client";

/** Human label for a cloud provider slug (falls back to uppercase). */
const PROVIDER_LABEL: Record<string, string> = {
	aws: "AWS",
	gcp: "GCP",
	azure: "Azure",
	alibaba: "Alibaba",
	digitalocean: "DigitalOcean",
	hetzner: "Hetzner",
	civo: "Civo",
};
function providerLabel(p: string): string {
	return PROVIDER_LABEL[p] ?? p.toUpperCase();
}

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

	return (
		<div className="flex items-center gap-2.5">
			<div className="relative flex-1">
				<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
				<Input
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					placeholder="Search projects…"
					className="h-10 pl-9 pr-12"
				/>
				<span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
					/
				</span>
			</div>

			<FilterMenu state={state} facets={facets} onChange={onChange} />

			<ViewToggle
				value={state.view}
				onChange={(view) => onChange({ view })}
				className="h-10"
			/>

			<CreateMenu orgSlug={orgSlug} />
		</div>
	);
}

/** The two-level filter + sort popover. */
function FilterMenu({
	state,
	facets,
	onChange,
}: {
	state: OverviewState;
	facets: ProjectListResult["facets"];
	onChange: (next: Partial<OverviewState>) => void;
}) {
	const [open, setOpen] = useState(false);
	const [panel, setPanel] = useState<"root" | "cloud" | "repo">("root");
	const filterCount = state.clouds.length + state.repos.length;

	// Reset back to the root panel whenever the popover closes.
	function onOpenChange(next: boolean) {
		setOpen(next);
		if (!next) setPanel("root");
	}

	const toggle = (key: "clouds" | "repos", value: string) => {
		const arr = state[key];
		onChange({
			[key]: arr.includes(value)
				? arr.filter((x) => x !== value)
				: [...arr, value],
		});
	};

	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					size="icon"
					className="relative h-10 w-10"
					aria-label="Filter & sort"
				>
					<SlidersHorizontal className="h-4 w-4" />
					{filterCount > 0 && (
						<span className="absolute -right-1.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-foreground px-1 font-mono text-[9px] text-background">
							{filterCount}
						</span>
					)}
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-64 p-2">
				{panel === "root" ? (
					<RootPanel
						state={state}
						facetCounts={{
							clouds: facets.clouds.length,
							repos: facets.repos.length,
						}}
						onChange={onChange}
						onOpenPanel={setPanel}
					/>
				) : panel === "cloud" ? (
					<CloudPanel
						clouds={facets.clouds}
						selected={state.clouds}
						onBack={() => setPanel("root")}
						onToggle={(c) => toggle("clouds", c)}
					/>
				) : (
					<RepoPanel
						repos={facets.repos}
						selected={state.repos}
						onBack={() => setPanel("root")}
						onToggle={(url) => toggle("repos", url)}
					/>
				)}
			</PopoverContent>
		</Popover>
	);
}

/** Level 1: pick a facet to drill into, and the sort order. */
function RootPanel({
	state,
	facetCounts,
	onChange,
	onOpenPanel,
}: {
	state: OverviewState;
	facetCounts: { clouds: number; repos: number };
	onChange: (next: Partial<OverviewState>) => void;
	onOpenPanel: (panel: "cloud" | "repo") => void;
}) {
	const dirty =
		state.clouds.length > 0 || state.repos.length > 0 || state.sort !== "activity";

	return (
		<>
			<div className="px-1.5 pb-1.5 pt-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
				Filter by
			</div>
			<FacetRow
				icon={GitBranch}
				label="Repository"
				count={state.repos.length}
				disabled={facetCounts.repos === 0}
				onClick={() => onOpenPanel("repo")}
			/>
			<FacetRow
				icon={Cloud}
				label="Cloud"
				count={state.clouds.length}
				disabled={facetCounts.clouds === 0}
				onClick={() => onOpenPanel("cloud")}
			/>

			<div className="my-1.5 h-px bg-border" />
			<div className="px-1.5 pb-1.5 pt-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
				Sort by
			</div>
			{(
				[
					{ key: "activity", label: "Activity", icon: Activity },
					{ key: "name", label: "Name", icon: Layers },
				] as const
			).map((opt) => (
				<button
					key={opt.key}
					type="button"
					onClick={() => onChange({ sort: opt.key })}
					className="flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
				>
					<opt.icon className="h-3.5 w-3.5" />
					<span className="flex-1 text-left">{opt.label}</span>
					{state.sort === opt.key && <Check className="h-3.5 w-3.5" />}
				</button>
			))}

			{dirty && (
				<>
					<div className="my-1.5 h-px bg-border" />
					<div className="flex justify-end">
						<button
							type="button"
							onClick={() =>
								onChange({ clouds: [], repos: [], sort: "activity" })
							}
							className="rounded-sm px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						>
							Reset
						</button>
					</div>
				</>
			)}
		</>
	);
}

/** A "Filter by" entry that drills into a facet selector. */
function FacetRow({
	icon: Icon,
	label,
	count,
	disabled,
	onClick,
}: {
	icon: typeof Cloud;
	label: string;
	count: number;
	disabled: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
		>
			<Icon className="h-3.5 w-3.5" />
			<span className="flex-1 text-left">{label}</span>
			{count > 0 && (
				<span className="grid h-4 min-w-4 place-items-center rounded-full bg-foreground px-1 font-mono text-[9px] text-background">
					{count}
				</span>
			)}
			<ChevronRight className="h-3.5 w-3.5" />
		</button>
	);
}

/** Level 2: searchable cloud selector. */
function CloudPanel({
	clouds,
	selected,
	onBack,
	onToggle,
}: {
	clouds: string[];
	selected: string[];
	onBack: () => void;
	onToggle: (cloud: string) => void;
}) {
	const [q, setQ] = useState("");
	const matches = clouds.filter((c) =>
		providerLabel(c).toLowerCase().includes(q.trim().toLowerCase()),
	);
	return (
		<FacetSelector
			title="Cloud"
			query={q}
			onQuery={setQ}
			onBack={onBack}
			empty={matches.length === 0}
		>
			{matches.map((c) => {
				const on = selected.includes(c);
				return (
					<FacetOption key={c} on={on} onClick={() => onToggle(c)}>
						<ProviderIcon provider={c} size={14} className="grayscale" />
						<span className="flex-1 truncate text-left">{providerLabel(c)}</span>
					</FacetOption>
				);
			})}
		</FacetSelector>
	);
}

/** Level 2: searchable repository selector. */
function RepoPanel({
	repos,
	selected,
	onBack,
	onToggle,
}: {
	repos: ProjectRepoRef[];
	selected: string[];
	onBack: () => void;
	onToggle: (url: string) => void;
}) {
	const [q, setQ] = useState("");
	const matches = repos.filter((r) =>
		r.label.toLowerCase().includes(q.trim().toLowerCase()),
	);
	return (
		<FacetSelector
			title="Repository"
			query={q}
			onQuery={setQ}
			onBack={onBack}
			empty={matches.length === 0}
		>
			{matches.map((r) => {
				const on = selected.includes(r.url);
				return (
					<FacetOption key={r.url} on={on} onClick={() => onToggle(r.url)}>
						<GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
						<span className="flex-1 truncate text-left font-mono text-[11px]">
							{r.label}
						</span>
					</FacetOption>
				);
			})}
		</FacetSelector>
	);
}

/** Shared chrome for a level-2 facet selector: back header + search + scrollable list. */
function FacetSelector({
	title,
	query,
	onQuery,
	onBack,
	empty,
	children,
}: {
	title: string;
	query: string;
	onQuery: (q: string) => void;
	onBack: () => void;
	empty: boolean;
	children: ReactNode;
}) {
	return (
		<>
			<button
				type="button"
				onClick={onBack}
				className="mb-1 flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
			>
				<ChevronLeft className="h-3.5 w-3.5" />
				{title}
			</button>
			<div className="relative mb-1.5">
				<Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
				<Input
					value={query}
					onChange={(e) => onQuery(e.target.value)}
					placeholder={`Search ${title.toLowerCase()}…`}
					className="h-8 pl-8 text-[13px]"
				/>
			</div>
			<div className="max-h-56 overflow-y-auto">
				{empty ? (
					<p className="px-2 py-3 text-center text-xs text-muted-foreground">
						No {title.toLowerCase()} found.
					</p>
				) : (
					children
				)}
			</div>
		</>
	);
}

/** A single toggleable facet option row with a check on the right when selected. */
function FacetOption({
	on,
	onClick,
	children,
}: {
	on: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
		>
			{children}
			{on && <Check className="h-3.5 w-3.5 shrink-0" />}
		</button>
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
					<Button size="default" className="h-10 gap-1.5">
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
