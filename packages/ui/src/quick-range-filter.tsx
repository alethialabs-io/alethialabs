"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Filter 1 — the quick-range dropdown. A Popover whose trigger shows the current
// selection label (clock icon + label + chevron). The panel is two columns: a preset list
// on the left, and on the right two typed-entry groups (relative + fixed) backed by chips
// and a free-text Input. All resolution goes through lib/filters/range (pure + tested).
// Generic and reusable — it takes a `value`/`label`/`onChange`, nothing usage-specific.

import { Check, Clock, ChevronDown } from "lucide-react";
import { useState } from "react";
import {
	type DateRange,
	parseRangeInput,
	presetRange,
	RANGE_PRESETS,
	type RangePreset,
} from "./range";
import { Badge } from "./badge";
import { Button } from "./button";
import { Input } from "./input";
import { Label } from "./label";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { cn } from "./utils";

const RELATIVE_CHIPS = [
	"45m",
	"12 hours",
	"10d",
	"2 weeks",
	"last month",
	"yesterday",
	"today",
];
const FIXED_CHIPS = ["Jan 1", "Jan 1 - Jan 2", "1/1", "1/1 - 1/2"];

interface QuickRangeFilterProps {
	/** The label shown on the trigger (and used to mark the active preset). */
	label: string;
	value: DateRange;
	onChange: (range: DateRange, label: string) => void;
	/** Override the preset list (defaults to the shared RANGE_PRESETS). */
	presets?: RangePreset[];
	align?: "start" | "center" | "end";
}

/** A clickable chip that resolves a relative/fixed range string on click. */
function Chip({ text, onPick }: { text: string; onPick: (text: string) => void }) {
	return (
		<button type="button" onClick={() => onPick(text)} className="appearance-none">
			<Badge
				variant="outline"
				className="cursor-pointer font-mono text-[11px] font-normal transition-colors hover:bg-surface-muted hover:text-text-primary"
			>
				{text}
			</Badge>
		</button>
	);
}

export function QuickRangeFilter({
	label,
	onChange,
	presets = RANGE_PRESETS,
	align = "end",
}: QuickRangeFilterProps) {
	const [open, setOpen] = useState(false);
	const [typed, setTyped] = useState("");
	const [typedError, setTypedError] = useState(false);

	/** Commit a resolved range + label and close. */
	function apply(range: DateRange, nextLabel: string) {
		onChange(range, nextLabel);
		setTyped("");
		setTypedError(false);
		setOpen(false);
	}

	/** Resolve a typed/chip string; flag an error if it isn't understood. */
	function applyText(text: string) {
		const parsed = parseRangeInput(text);
		if (!parsed) {
			setTypedError(true);
			return;
		}
		apply(parsed, text.trim());
	}

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="outline" size="sm" className="gap-1.5">
					<Clock size={14} />
					{label}
					<ChevronDown size={13} className="text-text-tertiary" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align={align} className="w-[460px] p-0">
				<div className="grid grid-cols-[170px_1fr]">
					{/* Left — preset list. */}
					<div className="flex flex-col gap-0.5 border-r border-border p-1.5">
						{presets.map((p) => {
							const active = p.label === label;
							return (
								<button
									key={p.id}
									type="button"
									onClick={() => apply(presetRange(p.id), p.label)}
									className={cn(
										"flex items-center justify-between rounded-sm px-2.5 py-1.5 text-left text-[13px] transition-colors",
										active
											? "bg-surface-muted text-text-primary"
											: "text-text-secondary hover:bg-surface-muted hover:text-text-primary",
									)}
								>
									{p.label}
									{active && <Check size={13} />}
								</button>
							);
						})}
					</div>

					{/* Right — typed relative + fixed entry. */}
					<div className="flex flex-col gap-4 p-3">
						<div className="flex flex-col gap-2">
							<Label className="text-[11px] uppercase tracking-wide text-text-tertiary">
								Type relative times
							</Label>
							<form
								onSubmit={(e) => {
									e.preventDefault();
									applyText(typed);
								}}
							>
								<Input
									value={typed}
									onChange={(e) => {
										setTyped(e.target.value);
										setTypedError(false);
									}}
									placeholder="e.g. 10d, 2 weeks"
									aria-invalid={typedError}
									className="h-8 text-[12.5px]"
								/>
							</form>
							<div className="flex flex-wrap gap-1.5">
								{RELATIVE_CHIPS.map((c) => (
									<Chip key={c} text={c} onPick={applyText} />
								))}
							</div>
							{typedError && (
								<p className="text-[11px] text-destructive">
									{`Try "10d", "2 weeks", "yesterday", or "Jan 1 - Jan 2".`}
								</p>
							)}
						</div>

						<div className="flex flex-col gap-2">
							<Label className="text-[11px] uppercase tracking-wide text-text-tertiary">
								Type fixed times
							</Label>
							<div className="flex flex-wrap gap-1.5">
								{FIXED_CHIPS.map((c) => (
									<Chip key={c} text={c} onPick={applyText} />
								))}
							</div>
						</div>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}
