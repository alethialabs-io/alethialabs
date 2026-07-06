"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Runners filter toolbar — name search + a filters popover (cloud / status / operator /
// region / version chips). State is owned by the page; this component is presentational
// and emits changes. Modeled on the overview toolbar.

import { Search, SlidersHorizontal } from "lucide-react";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/popover";
import { ProviderIcon, PROVIDER_LABELS, type Provider } from "@repo/ui/provider-icon";
import { cn } from "@repo/ui/utils";

/** Active filter selections for the runners grid. Empty arrays mean "no filter". */
export interface RunnerFilters {
	clouds: string[];
	statuses: string[];
	operators: string[];
	regions: string[];
	versions: string[];
}

/** An empty filter set — the page's initial state and the Reset target. */
export const EMPTY_RUNNER_FILTERS: RunnerFilters = {
	clouds: [],
	statuses: [],
	operators: [],
	regions: [],
	versions: [],
};

const STATUS_OPTIONS = [
	{ value: "ONLINE", label: "Online" },
	{ value: "OFFLINE", label: "Offline" },
	{ value: "DRAINING", label: "Draining" },
];

const OPERATOR_OPTIONS = [
	{ value: "managed", label: "Managed" },
	{ value: "deployed", label: "Self · Deployed" },
	{ value: "registered", label: "Self · Registered" },
];

/** A chip used inside the filters popover; filled when selected. */
function Chip({
	on,
	onClick,
	children,
	mono,
}: {
	on: boolean;
	onClick: () => void;
	children: React.ReactNode;
	mono?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 transition-colors",
				mono ? "font-mono text-[11px]" : "text-xs",
				on
					? "border-foreground bg-foreground text-background"
					: "text-muted-foreground hover:border-foreground/40 hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}

/** A labelled group of chips in the popover; renders nothing when there are no options. */
function ChipGroup<T extends { value: string; label: string }>({
	title,
	options,
	selected,
	onToggle,
	render,
	mono,
}: {
	title: string;
	options: T[];
	selected: string[];
	onToggle: (value: string) => void;
	render?: (opt: T, on: boolean) => React.ReactNode;
	mono?: boolean;
}) {
	if (options.length === 0) return null;
	return (
		<>
			<div className="px-1.5 pb-1.5 pt-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
				{title}
			</div>
			<div className="flex flex-wrap gap-1.5 px-1 pb-2">
				{options.map((opt) => {
					const on = selected.includes(opt.value);
					return (
						<Chip key={opt.value} on={on} onClick={() => onToggle(opt.value)} mono={mono}>
							{render ? render(opt, on) : opt.label}
						</Chip>
					);
				})}
			</div>
		</>
	);
}

export function RunnersToolbar({
	query,
	onQueryChange,
	filters,
	onFiltersChange,
	availableClouds,
	availableRegions,
	availableVersions,
}: {
	query: string;
	onQueryChange: (q: string) => void;
	filters: RunnerFilters;
	onFiltersChange: (f: RunnerFilters) => void;
	availableClouds: string[];
	availableRegions: string[];
	availableVersions: string[];
}) {
	const filterCount =
		filters.clouds.length +
		filters.statuses.length +
		filters.operators.length +
		filters.regions.length +
		filters.versions.length;

	const toggle = (key: keyof RunnerFilters, value: string) => {
		const arr = filters[key];
		onFiltersChange({
			...filters,
			[key]: arr.includes(value) ? arr.filter((x) => x !== value) : [...arr, value],
		});
	};

	const cloudOptions = availableClouds.map((c) => ({
		value: c,
		label: c === "any" ? "Any" : (PROVIDER_LABELS[c as Provider] ?? c.toUpperCase()),
	}));
	const regionOptions = availableRegions.map((r) => ({ value: r, label: r }));
	const versionOptions = availableVersions.map((v) => ({ value: v, label: `v${v}` }));

	return (
		<div className="flex items-center gap-2.5">
			<div className="relative flex-1">
				<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
				<Input
					value={query}
					onChange={(e) => onQueryChange(e.target.value)}
					placeholder="Search runners by name…"
					className="h-9 pl-9"
				/>
			</div>

			<Popover>
				<PopoverTrigger asChild>
					<Button variant="outline" size="icon" className="relative h-9 w-9" aria-label="Filters">
						<SlidersHorizontal className="h-4 w-4" />
						{filterCount > 0 && (
							<span className="absolute -right-1.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-foreground px-1 font-mono text-[9px] text-background">
								{filterCount}
							</span>
						)}
					</Button>
				</PopoverTrigger>
				<PopoverContent align="end" className="w-72 p-2">
					<ChipGroup
						title="Cloud"
						options={cloudOptions}
						selected={filters.clouds}
						onToggle={(v) => toggle("clouds", v)}
						render={(opt, on) => (
							<>
								{opt.value !== "any" && (
									<ProviderIcon
										provider={opt.value}
										size={13}
										className={on ? "invert grayscale" : "grayscale"}
									/>
								)}
								{opt.label}
							</>
						)}
					/>
					<ChipGroup
						title="Status"
						options={STATUS_OPTIONS}
						selected={filters.statuses}
						onToggle={(v) => toggle("statuses", v)}
					/>
					<ChipGroup
						title="Operator"
						options={OPERATOR_OPTIONS}
						selected={filters.operators}
						onToggle={(v) => toggle("operators", v)}
					/>
					<ChipGroup
						title="Region"
						options={regionOptions}
						selected={filters.regions}
						onToggle={(v) => toggle("regions", v)}
						mono
					/>
					<ChipGroup
						title="Version"
						options={versionOptions}
						selected={filters.versions}
						onToggle={(v) => toggle("versions", v)}
						mono
					/>

					{filterCount > 0 && (
						<>
							<div className="my-1.5 h-px bg-border" />
							<div className="flex justify-end">
								<button
									type="button"
									onClick={() => onFiltersChange(EMPTY_RUNNER_FILTERS)}
									className="rounded-sm px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
								>
									Reset
								</button>
							</div>
						</>
					)}
				</PopoverContent>
			</Popover>
		</div>
	);
}

/** Pure predicate: does a runner pass the active filters? Exported so the page reuses the
 *  exact operator/cloud/region/version semantics the chips imply. */
export function matchesRunnerFilters(
	runner: {
		status: string | null;
		operator: string;
		provisioning: string | null;
		supported_providers: string[] | null;
		location: string | null;
		version: string | null;
		runner_releases: { version: string } | null;
	},
	filters: RunnerFilters,
): boolean {
	if (filters.statuses.length && !filters.statuses.includes(runner.status ?? "OFFLINE")) {
		return false;
	}
	if (filters.operators.length) {
		const key =
			runner.operator === "managed" ? "managed" : (runner.provisioning ?? "registered");
		if (!filters.operators.includes(key)) return false;
	}
	if (filters.clouds.length) {
		const providers = runner.supported_providers;
		const matched =
			!providers || providers.length === 0
				? filters.clouds.includes("any")
				: providers.some((p) => filters.clouds.includes(p));
		if (!matched) return false;
	}
	if (filters.regions.length && !(runner.location && filters.regions.includes(runner.location))) {
		return false;
	}
	if (filters.versions.length) {
		const v = runner.runner_releases?.version ?? runner.version;
		if (!v || !filters.versions.includes(v)) return false;
	}
	return true;
}
