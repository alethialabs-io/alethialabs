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
  /**
   * A facet count, rendered as the chip's trailing mono figure. It lives here, not at the
   * call site, because every filter bar that re-derived it did so as `opacity-60` over the
   * chip's ink — and an alpha over `--muted-foreground` composites to a grey no token can
   * rescue (#4197: at α=0.6 over the page background the darkest reachable ink is 2.9:1).
   * The count is a real tier, `--text-tertiary`, at full strength.
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
        // there; only the resting chip has a tertiary tier to step down to. That asymmetry
        // is a TOKEN GAP, recorded in #4309: `tokens.css` has `--text-on-ink` but does not
        // expose it as a `--color-*` utility, so there is no on-ink tertiary rung. The old
        // `opacity-60` supplied the hierarchy and was the banned composite — do not put it
        // back without a rung to put it on. The space is
        // for the accessible name ("Healthy 3", not "Healthy3") — a whitespace-only run
        // between flex items is not laid out, so `gap-1.5` alone sets the visual gap.
        <>
          {" "}
          <span
            className={cn(
              "font-mono text-ui-2xs",
              // The two halves of one control brighten together. Without the
              // group-hover rung the label snapped to `--foreground` while the count
              // stayed tertiary, which the call-site span (no colour class, so it
              // inherited) never did.
              !on && "text-text-tertiary group-hover:text-foreground",
            )}
          >
            {count}
          </span>
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
