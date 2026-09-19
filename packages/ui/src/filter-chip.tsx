// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The console's inline toggle-filter language: a rounded chip that fills with ink when
// selected. Use a FilterChipGroup for low-cardinality (≤ ~7), always-visible facets where
// seeing every option at once is the point (stage, status); reach for FacetFilter /
// MultiCombobox when the list is long or searchable. Promoted from the runners toolbar —
// prop names are kept drop-in compatible with its local Chip/ChipGroup.

import { CountFigure } from "./count-pill";
import { cn } from "./utils";

interface FilterChipProps {
	on: boolean;
	onClick: () => void;
	children: React.ReactNode;
	/** Render the label in the mono voice (versions, regions, other technical values). */
	mono?: boolean;
	/**
	 * A facet count, rendered as the chip's trailing mono figure. It lives here, not at the
	 * call site, because every filter bar that re-derived it did so as `opacity-60` over the
	 * chip's ink — and an alpha over `--muted-foreground` composites to a grey no token can
	 * rescue (#4197: at α=0.6 over the page background the darkest reachable ink is 2.9:1).
	 * The count is a real tier, `--text-tertiary`, at full strength — and since #4309 it is
	 * the shared {@link CountFigure}, so this chip and the three other filter surfaces that
	 * render the same figure cannot drift apart again.
	 */
	count?: number;
	className?: string;
}

/** A single toggleable filter chip; filled when selected, `aria-pressed` for state. */
export function FilterChip({
	on,
	onClick,
	children,
	mono,
	count,
	className,
}: FilterChipProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={on}
			className={cn(
				"inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 transition-colors",
				mono ? "font-mono text-[11px]" : "text-xs",
				// `group` so the count can follow the label on hover — see the count span below.
				"group",
				on
					? "border-foreground bg-foreground text-background"
					: "text-muted-foreground hover:border-foreground/40 hover:text-foreground",
				className,
			)}
		>
			{children}
			{count !== undefined && (
				// A filled chip is inverted ink end to end, so the count inherits `text-background`
				// there; only the resting chip has a tertiary tier to step down to. That asymmetry is
				// a TOKEN GAP, and #4309 CLOSED WITHOUT CLOSING IT: `tokens.css` defines
				// `--text-on-ink` but the `@theme` block does not expose it as a `--color-*`
				// utility, so there is no `text-text-on-ink` and no on-ink tertiary rung to step
				// down to. The old `opacity-60` supplied that hierarchy and was the banned
				// composite. Exposing the token is a DESIGN decision, not a conformance lane's to
				// take, so the absence is written here rather than filled — a future reader who
				// finds a filled chip flat is looking at a missing token, not a missing alpha.
				// The space is for the accessible name ("Healthy 3", not "Healthy3") — a
				// whitespace-only run between flex items is not laid out, so `gap-1.5` alone sets
				// the visual gap.
				<>
					{" "}
					<CountFigure
						className={
							// A resting chip takes CountFigure's own tertiary tier, plus a hover rung
							// so the two halves of one control brighten together — without it the
							// label snapped to `--foreground` while the count stayed tertiary. A
							// FILLED chip is inverted, so the figure gives its tier back and inherits
							// the chip's `text-background`; `text-inherit` and `text-text-tertiary`
							// are one tailwind-merge class group, so the later wins outright.
							on ? "text-inherit" : "group-hover:text-foreground"
						}
					>
						{count}
					</CountFigure>
				</>
			)}
		</button>
	);
}

/** The minimal option shape a chip group renders; extend it for richer `render` callbacks. */
export interface FilterChipOption {
	value: string;
	label: string;
	/** A facet count over the unfiltered universe; rendered by the chip when present. */
	count?: number;
}

interface FilterChipGroupProps<T extends FilterChipOption> {
	/** Mono uppercase group header — for popover use; omit when the group sits inline in a bar. */
	title?: string;
	options: T[];
	selected: string[];
	onToggle: (value: string) => void;
	/**
	 * Custom chip content (e.g. a ProviderIcon next to the label).
	 *
	 * A `render` callback OWNS the whole chip, so the group stops passing `count` when one is
	 * given: the four call sites this replaced each printed `opt.count` inside their own `render`,
	 * and forwarding both would render `Healthy 3 3` — and that becomes the accessible name.
	 */
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
						<FilterChip
							key={opt.value}
							on={on}
							onClick={() => onToggle(opt.value)}
							mono={mono}
							count={render ? undefined : opt.count}
						>
							{render ? render(opt, on) : opt.label}
						</FilterChip>
					);
				})}
			</div>
		</div>
	);
}
