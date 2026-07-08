// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Evidence table toolbar — search, group-by / sort-by segmented toggles, stage pills,
// a result count, and a reset. Purely controlled; the client owns the filter state.

import { Input } from "@repo/ui/input";
import { cn } from "@repo/ui/utils";
import type { GroupMode, SortKey } from "./evidence-derive";
import { EvIcon } from "./evidence-status";

/** A small labelled segmented toggle (group / sort). */
function Segmented<T extends string>({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: T;
	options: { key: T; label: string }[];
	onChange: (v: T) => void;
}) {
	return (
		<div className="inline-flex items-center gap-1.5">
			<span className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-disabled">
				{label}
			</span>
			<div className="inline-flex gap-0.5 rounded-md border bg-surface-sunken p-[3px]">
				{options.map((o) => (
					<button
						key={o.key}
						type="button"
						onClick={() => onChange(o.key)}
						className={cn(
							"h-[30px] rounded-sm px-3 font-mono text-[10px] uppercase tracking-wide transition-colors",
							value === o.key
								? "bg-surface text-text-primary shadow-sm"
								: "text-text-tertiary hover:text-text-secondary",
						)}
					>
						{o.label}
					</button>
				))}
			</div>
		</div>
	);
}

export interface StagePill {
	key: string;
	label: string;
	count: number;
}

/** The full toolbar: search row + group/sort toggles, then the stage pills + result count. */
export function EvidenceToolbar({
	search,
	onSearch,
	group,
	onGroup,
	sort,
	onSort,
	stage,
	onStage,
	stages,
	resultCount,
	total,
	filtered,
	onReset,
}: {
	search: string;
	onSearch: (v: string) => void;
	group: GroupMode;
	onGroup: (v: GroupMode) => void;
	sort: SortKey;
	onSort: (v: SortKey) => void;
	stage: string;
	onStage: (v: string) => void;
	stages: StagePill[];
	resultCount: number;
	total: number;
	filtered: boolean;
	onReset: () => void;
}) {
	return (
		<div className="flex flex-col gap-3.5">
			<div className="flex flex-wrap items-center gap-2.5">
				<div className="flex h-[38px] min-w-[230px] flex-1 items-center gap-2.5 rounded-md border bg-surface px-3">
					<EvIcon name="search" className="shrink-0 text-text-tertiary" size={16} />
					<Input
						value={search}
						onChange={(e) => onSearch(e.target.value)}
						placeholder="Filter by project or environment…"
						className="h-auto min-w-0 flex-1 border-0 bg-transparent px-0 py-0 text-[13.5px] shadow-none focus-visible:ring-0"
					/>
				</div>
				<Segmented<GroupMode>
					label="Group"
					value={group}
					onChange={onGroup}
					options={[
						{ key: "triage", label: "Triage" },
						{ key: "project", label: "Project" },
						{ key: "stage", label: "Stage" },
					]}
				/>
				<Segmented<SortKey>
					label="Sort"
					value={sort}
					onChange={onSort}
					options={[
						{ key: "worst", label: "Worst" },
						{ key: "stale", label: "Stale" },
						{ key: "name", label: "Name" },
					]}
				/>
			</div>

			<div className="flex flex-wrap items-center gap-2.5">
				{stages.map((p) => (
					<button
						key={p.key}
						type="button"
						onClick={() => onStage(p.key)}
						className={cn(
							"inline-flex h-[29px] items-center gap-1.5 rounded-full border px-3 font-mono text-[10.5px] transition-colors",
							stage === p.key
								? "border-border-strong bg-surface-muted text-text-primary"
								: "border-border text-text-tertiary hover:text-text-secondary",
						)}
					>
						{p.label}
						<span className="text-[9.5px] opacity-70">{p.count}</span>
					</button>
				))}
				<span className="flex-1" />
				{filtered && (
					<button
						type="button"
						onClick={onReset}
						className="inline-flex items-center gap-1.5 rounded-sm px-2 py-1.5 font-mono text-[10px] uppercase tracking-wide text-text-tertiary transition-colors hover:text-text-primary"
					>
						<EvIcon name="x" size={12} />
						Clear filters
					</button>
				)}
				<span className="font-mono text-[11px] text-text-tertiary">
					<b className="font-semibold text-text-primary">{resultCount}</b> of{" "}
					{total} environments
				</span>
			</div>
		</div>
	);
}
