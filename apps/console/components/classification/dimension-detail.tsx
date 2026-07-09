"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The selected dimension's detail pane — header (label / immutable key / description / edit /
// delete), the single-vs-multi switch, the values list (drag-to-reorder, color accent, usage
// bar + a drill into the resources carrying each value, edit / delete), an inline add-value
// input, and the "coverage by resource kind" panel (loaded lazily for the selected dimension).

import { Input } from "@repo/ui/input";
import { Switch } from "@repo/ui/switch";
import { cn } from "@repo/ui/utils";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, GripVertical, Lock, Pencil, Plus, Trash2, X } from "lucide-react";
import { useRef, useState } from "react";
import type { DimensionDTO, ValueDTO } from "@/app/server/actions/classification/dimensions";
import { getDimensionResourceBreakdown } from "@/app/server/actions/classification/assignments";
import { kindLabel } from "./resource-kind-labels";

/** Reorders `ids` by moving `dragId` to `targetId`'s slot. */
function moved(ids: string[], dragId: string, targetId: string): string[] {
	if (dragId === targetId) return ids;
	const next = ids.filter((i) => i !== dragId);
	const at = next.indexOf(targetId);
	next.splice(at, 0, dragId);
	return next;
}

/** A single value row. */
function ValueRow({
	value,
	maxUsage,
	canEdit,
	reorderable,
	onDragStart,
	onDrop,
	onDrill,
	onEdit,
	onDelete,
}: {
	value: ValueDTO;
	maxUsage: number;
	canEdit: boolean;
	reorderable: boolean;
	onDragStart: () => void;
	onDrop: () => void;
	onDrill: () => void;
	onEdit: () => void;
	onDelete: () => void;
}) {
	const pct = maxUsage > 0 ? Math.round((value.assignmentCount / maxUsage) * 100) : 0;
	return (
		<div
			draggable={reorderable}
			onDragStart={onDragStart}
			onDragOver={(e) => reorderable && e.preventDefault()}
			onDrop={onDrop}
			className="flex items-center gap-2.5 rounded-[2px] px-3 py-2 transition-colors hover:bg-surface-sunken"
		>
			{reorderable && (
				<GripVertical className="size-3 shrink-0 cursor-grab text-text-disabled" aria-hidden />
			)}
			<span
				className="size-2.5 shrink-0 rounded-full"
				style={{
					background: value.color ?? "transparent",
					border: value.color ? undefined : "1.5px solid var(--border-strong)",
				}}
			/>
			<div className="w-[190px] min-w-0">
				<div className="truncate text-[13px] font-medium text-text-primary">
					{value.label}
				</div>
				<div className="font-mono text-[10px] text-text-tertiary">{value.value}</div>
			</div>
			<div className="flex min-w-0 flex-1 items-center gap-2.5">
				<div className="h-[5px] max-w-[180px] flex-1 overflow-hidden rounded-full border bg-surface-sunken">
					<div
						className="h-full rounded-full"
						style={{
							width: `${pct}%`,
							background: value.color ?? "var(--text-tertiary)",
						}}
					/>
				</div>
				<button
					type="button"
					onClick={onDrill}
					className="inline-flex items-center gap-1.5 rounded-[2px] border border-transparent px-1.5 py-1 text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary"
					title="Which resources carry this value"
				>
					<span className="font-mono text-[11px]">{value.assignmentCount}</span>
					<span className="text-[10.5px] text-text-tertiary">
						{value.assignmentCount === 1 ? "resource" : "resources"}
					</span>
					<ChevronRight className="size-[11px]" />
				</button>
			</div>
			{canEdit && (
				<div className="flex shrink-0 items-center gap-1">
					<button
						type="button"
						onClick={onEdit}
						aria-label="Edit value"
						className="grid size-[27px] place-items-center rounded-[2px] text-text-tertiary transition-colors hover:bg-surface-muted hover:text-text-primary"
					>
						<Pencil className="size-[13px]" />
					</button>
					<button
						type="button"
						onClick={onDelete}
						aria-label="Delete value"
						className="grid size-[27px] place-items-center rounded-[2px] text-text-tertiary transition-colors hover:bg-[var(--signal-critical-surface)] hover:text-text-primary"
					>
						<X className="size-[13px]" />
					</button>
				</div>
			)}
		</div>
	);
}

/** The "coverage by resource kind" panel for the selected dimension (lazy). */
function CoverageByKind({ dim }: { dim: DimensionDTO }) {
	const { data } = useQuery({
		queryKey: ["classification", "dimension-breakdown", dim.id],
		queryFn: () => getDimensionResourceBreakdown(dim.id),
	});
	const rows = data ?? [];
	const max = rows.reduce((n, r) => Math.max(n, r.count), 0);

	return (
		<div className="border-t bg-surface-sunken px-5 pb-[18px] pt-[15px]">
			<div className="mb-3 flex items-center gap-2">
				<span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-text-tertiary">
					Coverage by resource kind
				</span>
				<div className="h-px flex-1 bg-border" />
				<span className="font-mono text-[10.5px] text-text-secondary">
					{dim.resourceCount} resources
				</span>
			</div>
			{rows.length === 0 ? (
				<div className="font-mono text-[11px] text-text-tertiary">
					Not yet assigned to any resource.
				</div>
			) : (
				<div className="grid grid-cols-1 gap-x-[26px] gap-y-2.5 sm:grid-cols-2">
					{rows.map((k) => (
						<div key={k.resource_kind} className="flex items-center gap-3">
							<span className="w-[104px] shrink-0 text-[12px] text-text-secondary">
								{kindLabel(k.resource_kind)}
							</span>
							<div className="h-[5px] flex-1 overflow-hidden rounded-full border bg-surface">
								<div
									className="h-full rounded-full bg-text-tertiary"
									style={{ width: max > 0 ? `${(k.count / max) * 100}%` : "0%" }}
								/>
							</div>
							<span className="w-[34px] text-right font-mono text-[10.5px] text-text-secondary">
								{k.count}
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

/** The selected dimension's detail pane. */
export function DimensionDetail({
	dim,
	canEdit,
	onEditDimension,
	onDeleteDimension,
	onToggleMulti,
	onReorderValues,
	onAddValue,
	onEditValue,
	onDeleteValue,
	onDrill,
}: {
	dim: DimensionDTO;
	canEdit: boolean;
	onEditDimension: () => void;
	onDeleteDimension: () => void;
	onToggleMulti: () => void;
	onReorderValues: (ids: string[]) => void;
	onAddValue: (label: string) => void;
	onEditValue: (value: ValueDTO) => void;
	onDeleteValue: (value: ValueDTO) => void;
	onDrill: (value: ValueDTO) => void;
}) {
	const [addValue, setAddValue] = useState("");
	const dragId = useRef<string | null>(null);
	const reorderable = canEdit && dim.values.length > 1;
	const maxUsage = dim.values.reduce((n, v) => Math.max(n, v.assignmentCount), 0);

	const submitAdd = () => {
		const label = addValue.trim();
		if (!label) return;
		onAddValue(label);
		setAddValue("");
	};

	return (
		<div className="overflow-hidden rounded-lg border bg-surface shadow-sm">
			{/* header */}
			<div className="border-b px-5 pb-4 pt-[17px]">
				<div className="flex items-start justify-between gap-4">
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-2.5">
							<h2 className="m-0 font-display text-[17px] font-semibold tracking-tight">
								{dim.label}
							</h2>
							<span className="inline-flex items-center gap-1.5 rounded-[2px] border bg-surface-sunken px-[7px] py-0.5 font-mono text-[10.5px] text-text-secondary">
								{dim.key}
								<Lock className="size-2.5 text-text-tertiary" aria-label="Key is immutable" />
							</span>
						</div>
						{dim.description && (
							<p className="m-0 mt-2 max-w-[60ch] text-[12.5px] leading-relaxed text-text-secondary">
								{dim.description}
							</p>
						)}
					</div>
					{canEdit && (
						<div className="flex shrink-0 items-center gap-1.5">
							<button
								type="button"
								onClick={onEditDimension}
								aria-label="Edit dimension"
								className="grid size-[30px] place-items-center rounded-[2px] border border-border-strong bg-surface text-text-secondary transition-colors hover:bg-surface-muted hover:text-text-primary"
							>
								<Pencil className="size-3.5" />
							</button>
							<button
								type="button"
								onClick={onDeleteDimension}
								aria-label="Delete dimension"
								className="grid size-[30px] place-items-center rounded-[2px] border border-border-strong bg-surface text-text-secondary transition-colors hover:bg-[var(--signal-critical-surface)] hover:text-text-primary"
							>
								<Trash2 className="size-3.5" />
							</button>
						</div>
					)}
				</div>

				{/* multi switch */}
				<div className="mt-3.5 flex items-center gap-2.5 border-t border-border-faint pt-3.5">
					{canEdit && (
						<Switch checked={dim.multi} onCheckedChange={onToggleMulti} aria-label="Allow multiple values" />
					)}
					<div>
						<div className="text-[12.5px] font-medium text-text-primary">
							{dim.multi ? "Multiple values per resource" : "One value per resource"}
						</div>
						<div className="mt-px text-[11px] text-text-tertiary">
							{dim.multi
								? "A resource may carry several values on this axis."
								: "Assigning a new value replaces the current one."}
						</div>
					</div>
				</div>
			</div>

			{/* values */}
			<div className="px-2 py-1.5">
				<div className="flex items-center gap-2 px-3 pb-2 pt-2.5">
					<span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-text-tertiary">
						Values
					</span>
					<span className="font-mono text-[10px] text-text-tertiary">
						{dim.values.length}
					</span>
					<div className="flex-1" />
					<span className="text-[11px] text-text-tertiary">sorted by position</span>
				</div>

				{dim.values.length === 0 ? (
					<div className="px-3 py-2 text-[12px] text-text-tertiary">
						No values yet — add one below.
					</div>
				) : (
					dim.values.map((v) => (
						<ValueRow
							key={v.id}
							value={v}
							maxUsage={maxUsage}
							canEdit={canEdit}
							reorderable={reorderable}
							onDragStart={() => {
								dragId.current = v.id;
							}}
							onDrop={() => {
								if (dragId.current && dragId.current !== v.id) {
									onReorderValues(
										moved(dim.values.map((x) => x.id), dragId.current, v.id),
									);
								}
								dragId.current = null;
							}}
							onDrill={() => onDrill(v)}
							onEdit={() => onEditValue(v)}
							onDelete={() => onDeleteValue(v)}
						/>
					))
				)}

				{canEdit && (
					<div className="flex items-center gap-2 px-3 pb-3 pt-2">
						<span className="size-[9px] shrink-0 rounded-full border-[1.5px] border-dashed border-border-strong" />
						<Input
							value={addValue}
							onChange={(e) => setAddValue(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									submitAdd();
								}
							}}
							placeholder="Add a value — type a label, press Enter"
							className="h-8 flex-1 border-border-strong bg-surface-sunken text-[12.5px]"
						/>
						<button
							type="button"
							onClick={submitAdd}
							className="inline-flex h-8 items-center gap-1.5 rounded-[2px] border border-border-strong bg-surface px-[11px] text-[12px] font-medium text-text-primary transition-colors hover:bg-surface-muted"
						>
							<Plus className="size-3" />
							Add
						</button>
					</div>
				)}
			</div>

			<CoverageByKind dim={dim} />
		</div>
	);
}
