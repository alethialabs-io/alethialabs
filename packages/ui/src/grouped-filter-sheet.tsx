"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A generic multi-select filter whose options are too many for a dropdown: a trigger opens
// a Sheet of Collapsible groups, each a checklist. The group header carries a count and a
// select-all toggle. Option-based and domain-free (no audit/event knowledge) — the caller
// passes `groups` + `value` + `onChange`; used for the Activity event-type filter.

import { Check, ChevronDown, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "./badge";
import { Button } from "./button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "./collapsible";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "./sheet";
import { cn } from "./utils";

export interface GroupedFilterOption {
	value: string;
	label: string;
}
export interface GroupedFilterGroup {
	label: string;
	options: GroupedFilterOption[];
}

interface GroupedFilterSheetProps {
	label: string;
	icon?: LucideIcon;
	groups: GroupedFilterGroup[];
	value: string[];
	onChange: (next: string[]) => void;
	title?: string;
	description?: string;
}

/** A small grayscale checkbox box. */
function CheckBox({ on }: { on: boolean }) {
	return (
		<span
			className={cn(
				"flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
				on ? "border-text-primary bg-text-primary text-surface" : "border-border",
			)}
		>
			{on && <Check size={11} />}
		</span>
	);
}

/** One collapsible category of checkable options. */
function Group({
	group,
	selected,
	onToggle,
	onToggleAll,
}: {
	group: GroupedFilterGroup;
	selected: Set<string>;
	onToggle: (v: string) => void;
	onToggleAll: (values: string[], on: boolean) => void;
}) {
	const values = group.options.map((o) => o.value);
	const count = values.filter((v) => selected.has(v)).length;
	const allOn = count === values.length && values.length > 0;
	const [open, setOpen] = useState(count > 0);

	return (
		<Collapsible
			open={open}
			onOpenChange={setOpen}
			className="border-b border-border last:border-b-0"
		>
			<div className="flex items-center gap-2 py-2.5">
				<button
					type="button"
					aria-label={allOn ? "Deselect all" : "Select all"}
					onClick={() => onToggleAll(values, !allOn)}
				>
					<CheckBox on={allOn} />
				</button>
				<CollapsibleTrigger className="group flex flex-1 items-center justify-between text-left">
					<span className="text-[13px] font-medium text-text-primary">
						{group.label}
					</span>
					<span className="flex items-center gap-2">
						{count > 0 && (
							<Badge
								variant="secondary"
								className="h-4 min-w-4 justify-center rounded-full px-1 font-mono text-[10px]"
							>
								{count}
							</Badge>
						)}
						<ChevronDown
							size={14}
							className="text-text-tertiary transition-transform group-data-[state=open]:rotate-180"
						/>
					</span>
				</CollapsibleTrigger>
			</div>
			<CollapsibleContent>
				<div className="flex flex-col gap-0.5 pb-2 pl-6">
					{group.options.map((o) => {
						const on = selected.has(o.value);
						return (
							<button
								key={o.value}
								type="button"
								onClick={() => onToggle(o.value)}
								className="flex items-center gap-2 rounded-sm px-1.5 py-1.5 text-left transition-colors hover:bg-surface-muted"
							>
								<CheckBox on={on} />
								<span className="text-[12.5px] text-text-secondary">{o.label}</span>
							</button>
						);
					})}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

/** A Sheet of collapsible, multi-select option groups. */
export function GroupedFilterSheet({
	label,
	icon: Icon,
	groups,
	value,
	onChange,
	title,
	description,
}: GroupedFilterSheetProps) {
	const [open, setOpen] = useState(false);
	const selected = new Set(value);

	function toggle(v: string) {
		const next = new Set(selected);
		if (next.has(v)) next.delete(v);
		else next.add(v);
		onChange([...next]);
	}
	function toggleAll(values: string[], on: boolean) {
		const next = new Set(selected);
		for (const v of values) {
			if (on) next.add(v);
			else next.delete(v);
		}
		onChange([...next]);
	}

	return (
		<>
			<Button
				variant="outline"
				size="sm"
				className="gap-1.5"
				onClick={() => setOpen(true)}
			>
				{Icon && <Icon size={14} />}
				{label}
				{selected.size > 0 && (
					<Badge
						variant="secondary"
						className="ml-0.5 h-4 min-w-4 justify-center rounded-full px-1 font-mono text-[10px]"
					>
						{selected.size}
					</Badge>
				)}
			</Button>
			<Sheet open={open} onOpenChange={setOpen}>
				<SheetContent side="right" className="w-full gap-0 sm:max-w-sm">
					<SheetHeader className="border-b border-border">
						<SheetTitle className="text-sm">{title ?? label}</SheetTitle>
						{description && (
							<SheetDescription className="text-[12.5px]">
								{description}
							</SheetDescription>
						)}
					</SheetHeader>
					<div className="flex-1 overflow-y-auto px-4">
						{groups.map((g) => (
							<Group
								key={g.label}
								group={g}
								selected={selected}
								onToggle={toggle}
								onToggleAll={toggleAll}
							/>
						))}
					</div>
					{selected.size > 0 && (
						<div className="border-t border-border p-4">
							<Button
								variant="outline"
								size="sm"
								className="w-full"
								onClick={() => onChange([])}
							>
								Clear {selected.size} selected
							</Button>
						</div>
					)}
				</SheetContent>
			</Sheet>
		</>
	);
}
