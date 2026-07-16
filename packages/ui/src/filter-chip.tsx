// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The console's inline toggle-filter language: a rounded chip that fills with ink when
// selected. Use a FilterChipGroup for low-cardinality (≤ ~7), always-visible facets where
// seeing every option at once is the point (stage, status); reach for FacetFilter /
// MultiCombobox when the list is long or searchable. Promoted from the runners toolbar —
// prop names are kept drop-in compatible with its local Chip/ChipGroup.

import { cn } from "./utils";

interface FilterChipProps {
	on: boolean;
	onClick: () => void;
	children: React.ReactNode;
	/** Render the label in the mono voice (versions, regions, other technical values). */
	mono?: boolean;
	className?: string;
}

/** A single toggleable filter chip; filled when selected, `aria-pressed` for state. */
export function FilterChip({ on, onClick, children, mono, className }: FilterChipProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={on}
			className={cn(
				"inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 transition-colors",
				mono ? "font-mono text-[11px]" : "text-xs",
				on
					? "border-foreground bg-foreground text-background"
					: "text-muted-foreground hover:border-foreground/40 hover:text-foreground",
				className,
			)}
		>
			{children}
		</button>
	);
}

/** The minimal option shape a chip group renders; extend it for richer `render` callbacks. */
export interface FilterChipOption {
	value: string;
	label: string;
}

interface FilterChipGroupProps<T extends FilterChipOption> {
	/** Mono uppercase group header — for popover use; omit when the group sits inline in a bar. */
	title?: string;
	options: T[];
	selected: string[];
	onToggle: (value: string) => void;
	/** Custom chip content (e.g. a ProviderIcon next to the label). */
	render?: (opt: T, on: boolean) => React.ReactNode;
	mono?: boolean;
	/** Lay the chips out as a single bar row (no popover padding). */
	inline?: boolean;
	className?: string;
}

/** A labelled group of toggle chips; renders nothing when there are no options. */
export function FilterChipGroup<T extends FilterChipOption>({
	title,
	options,
	selected,
	onToggle,
	render,
	mono,
	inline,
	className,
}: FilterChipGroupProps<T>) {
	if (options.length === 0) return null;
	return (
		<div role="group" aria-label={title} className={className}>
			{title && (
				<div className="px-1.5 pb-1.5 pt-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
					{title}
				</div>
			)}
			<div
				className={cn(
					"flex flex-wrap gap-1.5",
					inline ? "items-center" : "px-1 pb-2",
				)}
			>
				{options.map((opt) => {
					const on = selected.includes(opt.value);
					return (
						<FilterChip key={opt.value} on={on} onClick={() => onToggle(opt.value)} mono={mono}>
							{render ? render(opt, on) : opt.label}
						</FilterChip>
					);
				})}
			</div>
		</div>
	);
}
