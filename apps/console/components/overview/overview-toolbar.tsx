"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Overview toolbar — project search, a filters/sort popover (cloud + region chips, sort
// radios), and an "Add new" popover. State for query/filters/sort is owned by the page;
// this component is presentational + emits changes.

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
	Activity,
	Box,
	Check,
	Cloud,
	Layers,
	Plus,
	Search,
	SlidersHorizontal,
	UserPlus,
} from "lucide-react";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/popover";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { getCollaborationAccess } from "@/app/server/actions/billing";
import { InviteMemberDialog } from "@/components/settings/members/invite-member-dialog";
import { UpgradeDialog } from "@/components/settings/upgrade/upgrade-dialog";
import { globalHref } from "@/lib/routing";

/** Active filter selections for the projects grid. */
export interface OverviewFilters {
	clouds: string[];
	regions: string[];
}

/** Sort order for the projects grid. */
export type OverviewSort = "activity" | "name";

/** Human label for a cloud provider slug. */
const PROVIDER_LABEL: Record<string, string> = {
	aws: "AWS",
	gcp: "GCP",
	azure: "Azure",
};
function providerLabel(p: string): string {
	return PROVIDER_LABEL[p] ?? p.toUpperCase();
}

export function OverviewToolbar({
	orgSlug,
	query,
	onQueryChange,
	filters,
	onFiltersChange,
	sort,
	onSortChange,
	availableClouds,
	availableRegions,
}: {
	orgSlug: string;
	query: string;
	onQueryChange: (q: string) => void;
	filters: OverviewFilters;
	onFiltersChange: (f: OverviewFilters) => void;
	sort: OverviewSort;
	onSortChange: (s: OverviewSort) => void;
	availableClouds: string[];
	availableRegions: string[];
}) {
	const filterCount = filters.clouds.length + filters.regions.length;

	const toggle = (key: keyof OverviewFilters, value: string) => {
		const arr = filters[key];
		onFiltersChange({
			...filters,
			[key]: arr.includes(value)
				? arr.filter((x) => x !== value)
				: [...arr, value],
		});
	};

	return (
		<div className="flex items-center gap-2.5">
			<div className="relative flex-1">
				<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
				<Input
					value={query}
					onChange={(e) => onQueryChange(e.target.value)}
					placeholder="Search projects by name or region…"
					className="h-10 pl-9 pr-12"
				/>
				<span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
					/
				</span>
			</div>

			{/* Filters & sort */}
			<Popover>
				<PopoverTrigger asChild>
					<Button
						variant="outline"
						size="icon"
						className="relative h-10 w-10"
						aria-label="Filters & sort"
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
					{availableClouds.length > 0 && (
						<>
							<div className="px-1.5 pb-1.5 pt-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
								Cloud
							</div>
							<div className="flex flex-wrap gap-1.5 px-1 pb-2">
								{availableClouds.map((c) => {
									const on = filters.clouds.includes(c);
									return (
										<button
											key={c}
											type="button"
											onClick={() => toggle("clouds", c)}
											className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors ${
												on
													? "border-foreground bg-foreground text-background"
													: "text-muted-foreground hover:border-foreground/40 hover:text-foreground"
											}`}
										>
											<ProviderIcon
												provider={c}
												size={13}
												className={on ? "invert grayscale" : "grayscale"}
											/>
											{providerLabel(c)}
										</button>
									);
								})}
							</div>
						</>
					)}

					{availableRegions.length > 0 && (
						<>
							<div className="px-1.5 pb-1.5 pt-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
								Region
							</div>
							<div className="flex flex-wrap gap-1.5 px-1 pb-2">
								{availableRegions.map((r) => {
									const on = filters.regions.includes(r);
									return (
										<button
											key={r}
											type="button"
											onClick={() => toggle("regions", r)}
											className={`inline-flex h-7 items-center rounded-full border px-2.5 font-mono text-[11px] transition-colors ${
												on
													? "border-foreground bg-foreground text-background"
													: "text-muted-foreground hover:border-foreground/40 hover:text-foreground"
											}`}
										>
											{r}
										</button>
									);
								})}
							</div>
						</>
					)}

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
							onClick={() => onSortChange(opt.key)}
							className="flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						>
							<opt.icon className="h-3.5 w-3.5" />
							<span className="flex-1 text-left">{opt.label}</span>
							{sort === opt.key && <Check className="h-3.5 w-3.5" />}
						</button>
					))}

					{(filterCount > 0 || sort !== "activity") && (
						<>
							<div className="my-1.5 h-px bg-border" />
							<div className="flex justify-end">
								<button
									type="button"
									onClick={() => {
										onFiltersChange({ clouds: [], regions: [] });
										onSortChange("activity");
									}}
									className="rounded-sm px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
								>
									Reset
								</button>
							</div>
						</>
					)}
				</PopoverContent>
			</Popover>

			<AddNewMenu orgSlug={orgSlug} />
		</div>
	);
}

/** "Add new" popover — quick actions to create a Project/Cloud/Org member. */
function AddNewMenu({ orgSlug }: { orgSlug: string }) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	// Invite is gated (card-backed/paid org). Open the invite dialog when allowed, else the
	// upsell — mirroring the members table. Dialogs render outside the popover so they
	// survive it closing.
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

	const items: {
		icon: typeof Box;
		name: string;
		desc: string;
		onSelect: () => void;
	}[] = [
		{
			icon: Layers,
			name: "Project",
			desc: "One config → one OpenTofu plan",
			onSelect: () => router.push(globalHref(orgSlug, "new")),
		},
		{
			icon: Cloud,
			name: "Cloud",
			desc: "Connect AWS, GCP or Azure",
			onSelect: () => router.push(`${globalHref(orgSlug, "connectors")}?type=cloud`),
		},
		{
			icon: UserPlus,
			name: "Org member",
			desc: "Invite to this organization",
			onSelect: () => (canInvite ? setInviteOpen(true) : setUpsellOpen(true)),
		},
	];

	return (
		<>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<Button size="default" className="h-10 gap-1.5">
						<Plus className="h-4 w-4" />
						Add new
					</Button>
				</PopoverTrigger>
				<PopoverContent align="end" className="w-72 p-1.5">
					<div className="px-1.5 pb-1 pt-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
						Create
					</div>
					{items.map((it) => (
						<button
							key={it.name}
							type="button"
							onClick={() => {
								setOpen(false);
								it.onSelect();
							}}
							className="flex w-full items-center gap-3 rounded-sm p-2 text-left transition-colors hover:bg-muted"
						>
							<span className="grid size-8 shrink-0 place-items-center rounded-sm border bg-muted/40 text-muted-foreground">
								<it.icon className="h-4 w-4" />
							</span>
							<span className="min-w-0 flex-1">
								<span className="block text-[13px] font-medium text-foreground">
									{it.name}
								</span>
								<span className="block font-mono text-[10px] text-muted-foreground">
									{it.desc}
								</span>
							</span>
						</button>
					))}
				</PopoverContent>
			</Popover>

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
