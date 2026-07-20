"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The shared "funnel" filter — a two-level "Filter by / Group by / Sort by" popover behind a
// single SlidersHorizontal trigger. Level 1 lists the facets (drill into a searchable
// selector), optional Group/Sort sections shown as right-checked choices, and a Reset. Level 2
// is a searchable option list with a check on the right (never a checkbox). One source of truth
// for the console filter language — the overview toolbar and the evidence surface both consume
// it (promote-shared, don't duplicate).

import {
	ChevronLeft,
	ChevronRight,
	Check,
	type LucideIcon,
	Search,
	SlidersHorizontal,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "./button";
import { Input } from "./input";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { cn } from "./utils";

/** One selectable option inside a facet's level-2 list. */
export interface FunnelOption {
	value: string;
	label: string;
	/** Match count shown after the label. */
	count?: number;
	/** Optional leading content (e.g. a provider icon). */
	leading?: ReactNode;
	/** Render the label in mono (e.g. repo slugs). */
	mono?: boolean;
}

/** A facet the funnel can filter by (drills into a searchable option list). */
export interface FunnelFacet {
	key: string;
	label: string;
	icon: LucideIcon;
	options: FunnelOption[];
}

/** A single-select choice row (used by the Group / Sort sections), checked on the right. */
export interface FunnelChoice {
	key: string;
	label: string;
	icon?: LucideIcon;
}

/**
 * The funnel filter popover. `selected` maps facet key → selected values; `onToggle` flips one.
 * Group/Sort are optional single-select sections. `dirty` controls the Reset affordance.
 */
export function FunnelFilter({
	facets,
	selected,
	onToggle,
	groups,
	group,
	onGroup,
	sorts,
	sort,
	onSort,
	onReset,
	dirty,
	align = "end",
	triggerClassName,
	ariaLabel = "Filter & sort",
}: {
	facets: FunnelFacet[];
	selected: Record<string, string[]>;
	onToggle: (facetKey: string, value: string) => void;
	groups?: FunnelChoice[];
	group?: string;
	onGroup?: (key: string) => void;
	sorts?: FunnelChoice[];
	sort?: string;
	onSort?: (key: string) => void;
	onReset: () => void;
	dirty: boolean;
	align?: "start" | "center" | "end";
	triggerClassName?: string;
	ariaLabel?: string;
}) {
	const [open, setOpen] = useState(false);
	const [panel, setPanel] = useState<string>("root");
	const filterCount = facets.reduce(
		(n, f) => n + (selected[f.key]?.length ?? 0),
		0,
	);

	function onOpenChange(next: boolean) {
		setOpen(next);
		if (!next) setPanel("root");
	}

	const activeFacet = facets.find((f) => f.key === panel) ?? null;

	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					size="icon"
					className={cn("relative h-10 w-10", triggerClassName)}
					aria-label={ariaLabel}
				>
					<SlidersHorizontal className="h-4 w-4" />
					{filterCount > 0 && (
						<span className="-right-1.5 -top-1.5 absolute grid h-4 min-w-4 place-items-center rounded-full bg-foreground px-1 font-mono text-[9px] text-background">
							{filterCount}
						</span>
					)}
				</Button>
			</PopoverTrigger>
			<PopoverContent align={align} className="w-64 p-2">
				{activeFacet ? (
					<FacetSelector
						facet={activeFacet}
						selected={selected[activeFacet.key] ?? []}
						onBack={() => setPanel("root")}
						onToggle={(v) => onToggle(activeFacet.key, v)}
					/>
				) : (
					<>
						{facets.length > 0 && (
							<>
								<SectionLabel>Filter by</SectionLabel>
								{facets.map((f) => (
									<FacetRow
										key={f.key}
										icon={f.icon}
										label={f.label}
										count={(selected[f.key] ?? []).length}
										disabled={f.options.length === 0}
										onClick={() => setPanel(f.key)}
									/>
								))}
							</>
						)}

						{groups && groups.length > 0 && onGroup && (
							<>
								<Divider />
								<SectionLabel>Group by</SectionLabel>
								{groups.map((g) => (
									<ChoiceRow
										key={g.key}
										choice={g}
										active={group === g.key}
										onClick={() => onGroup(g.key)}
									/>
								))}
							</>
						)}

						{sorts && sorts.length > 0 && onSort && (
							<>
								<Divider />
								<SectionLabel>Sort by</SectionLabel>
								{sorts.map((s) => (
									<ChoiceRow
										key={s.key}
										choice={s}
										active={sort === s.key}
										onClick={() => onSort(s.key)}
									/>
								))}
							</>
						)}

						{dirty && (
							<>
								<Divider />
								<div className="flex justify-end">
									<button
										type="button"
										onClick={onReset}
										className="rounded-sm px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
									>
										Reset
									</button>
								</div>
							</>
						)}
					</>
				)}
			</PopoverContent>
		</Popover>
	);
}

/** A mono uppercase section eyebrow. */
function SectionLabel({ children }: { children: ReactNode }) {
	return (
		<div className="px-1.5 pt-1 pb-1.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
			{children}
		</div>
	);
}

function Divider() {
	return <div className="my-1.5 h-px bg-border" />;
}

/** A "Filter by" entry that drills into a facet selector. */
function FacetRow({
	icon: Icon,
	label,
	count,
	disabled,
	onClick,
}: {
	icon: LucideIcon;
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

/** A single-select choice row (Group / Sort) with a check on the right when active. */
function ChoiceRow({
	choice,
	active,
	onClick,
}: {
	choice: FunnelChoice;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
		>
			{choice.icon && <choice.icon className="h-3.5 w-3.5" />}
			<span className="flex-1 text-left">{choice.label}</span>
			{active && <Check className="h-3.5 w-3.5" />}
		</button>
	);
}

/** Level 2: a searchable facet option list; check on the right (never a checkbox). */
function FacetSelector({
	facet,
	selected,
	onBack,
	onToggle,
}: {
	facet: FunnelFacet;
	selected: string[];
	onBack: () => void;
	onToggle: (value: string) => void;
}) {
	const [q, setQ] = useState("");
	const matches = facet.options.filter((o) =>
		o.label.toLowerCase().includes(q.trim().toLowerCase()),
	);
	return (
		<>
			<button
				type="button"
				onClick={onBack}
				className="mb-1 flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
			>
				<ChevronLeft className="h-3.5 w-3.5" />
				{facet.label}
			</button>
			<div className="relative mb-1.5">
				<Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
				<Input
					value={q}
					onChange={(e) => setQ(e.target.value)}
					placeholder={`Search ${facet.label.toLowerCase()}…`}
					className="h-8 pl-8 text-[13px]"
				/>
			</div>
			<div className="max-h-56 overflow-y-auto">
				{matches.length === 0 ? (
					<p className="px-2 py-3 text-center text-xs text-muted-foreground">
						No {facet.label.toLowerCase()} found.
					</p>
				) : (
					matches.map((o) => {
						const on = selected.includes(o.value);
						return (
							<button
								key={o.value}
								type="button"
								onClick={() => onToggle(o.value)}
								className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							>
								{o.leading}
								<span
									className={cn(
										"flex-1 truncate text-left",
										o.mono && "font-mono text-[11px]",
									)}
								>
									{o.label}
								</span>
								{typeof o.count === "number" && (
									<span className="font-mono text-[10px] text-muted-foreground/70 tabular-nums">
										{o.count}
									</span>
								)}
								{on && <Check className="h-3.5 w-3.5 shrink-0" />}
							</button>
						);
					})
				)}
			</div>
		</>
	);
}
