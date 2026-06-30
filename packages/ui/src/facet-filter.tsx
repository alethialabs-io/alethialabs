"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A generic multi-select facet filter: a Popover whose trigger shows an icon + label + a
// count badge, opening a searchable Command list of checkbox options. Resolution-free and
// option-based (no domain knowledge), so it backs e.g. a "User" or "Project" filter equally —
// the caller passes `options` + `value` + `onChange`. Sibling of quick-range-filter.

import { Check, ChevronDown, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "./badge";
import { Button } from "./button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "./command";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { cn } from "./utils";

export interface FacetOption {
	value: string;
	label: string;
	/** Optional secondary text shown muted after the label (e.g. an email). */
	hint?: string;
}

interface FacetFilterProps {
	label: string;
	icon?: LucideIcon;
	options: FacetOption[];
	value: string[];
	onChange: (next: string[]) => void;
	align?: "start" | "center" | "end";
	searchPlaceholder?: string;
	emptyText?: string;
}

/** A searchable multi-select dropdown. Selecting toggles; the popover stays open. */
export function FacetFilter({
	label,
	icon: Icon,
	options,
	value,
	onChange,
	align = "start",
	searchPlaceholder = "Search…",
	emptyText = "No matches.",
}: FacetFilterProps) {
	const [open, setOpen] = useState(false);
	const selected = new Set(value);

	function toggle(v: string) {
		const next = new Set(selected);
		if (next.has(v)) next.delete(v);
		else next.add(v);
		onChange([...next]);
	}

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="outline" size="sm" className="gap-1.5">
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
					<ChevronDown size={13} className="text-text-tertiary" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align={align} className="w-[240px] p-0">
				<Command>
					<CommandInput placeholder={searchPlaceholder} className="text-[12.5px]" />
					<CommandList>
						<CommandEmpty>{emptyText}</CommandEmpty>
						<CommandGroup>
							{options.map((o) => {
								const isOn = selected.has(o.value);
								return (
									<CommandItem
										key={o.value}
										value={`${o.label} ${o.hint ?? ""} ${o.value}`}
										onSelect={() => toggle(o.value)}
										className="gap-2"
									>
										<span
											className={cn(
												"flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
												isOn
													? "border-text-primary bg-text-primary text-surface"
													: "border-border",
											)}
										>
											{isOn && <Check size={11} />}
										</span>
										<span className="truncate text-text-primary">{o.label}</span>
										{o.hint && (
											<span className="ml-auto truncate font-mono text-[10.5px] text-text-tertiary">
												{o.hint}
											</span>
										)}
									</CommandItem>
								);
							})}
						</CommandGroup>
					</CommandList>
				</Command>
				{selected.size > 0 && (
					<div className="border-t border-border p-1">
						<Button
							variant="ghost"
							size="sm"
							className="w-full justify-center text-[12px] text-text-tertiary"
							onClick={() => onChange([])}
						>
							Clear {selected.size} selected
						</Button>
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}
