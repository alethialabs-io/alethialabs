"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A generic multi-select facet filter: a Popover whose trigger NAMES what is selected, opening a
// list of checkbox options. Resolution-free and option-based (no domain knowledge), so it backs e.g.
// a "User" or "Project" filter equally — the caller passes `options` + `value` + `onChange`. Sibling
// of quick-range-filter.
//
// The trigger, per the polish-wave spec §3 (#7737):
//   - nothing selected: `Name ▾`, in the secondary ink;
//   - one or two selected: `Name: A, B`; more than two: `Name · N`. The control takes a raised
//     border and background, and the chevron gives way to a × that clears THIS facet only.
//
// The × is a SIBLING button, not a span inside the trigger: a click target nested in a button is
// not reachable by keyboard and is not announced, and nesting a button in a button is invalid HTML.
// So the selected control is a split button — the popover trigger and the clear — sharing one box.

import { Check, ChevronDown, X, type LucideIcon } from "lucide-react";
import * as React from "react";
import { Button } from "./button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./command";
import { useCommandSearch } from "./command-search";
import { CountFigure, rowAccessibleName } from "./count-pill";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { cn } from "./utils";

export interface FacetOption {
  value: string;
  label: string;
  /** Optional secondary text shown muted after the label (e.g. an email). */
  hint?: string;
  /**
   * How many rows this option covers in the UNFILTERED universe (the filter standard's facet
   * count). Rendered as the option's trailing figure, after `hint` — so an option can carry both
   * an email and a count, which a count passed as `hint` could not.
   */
  count?: number;
}

/**
 * Above this many options the popover carries a search box. Up to it, every option fits in the
 * 240px popover at once and a search box is one more thing to read past.
 */
export const FACET_SEARCH_THRESHOLD = 8;

/** Past this many selected values the trigger shows a count (`Name · N`) instead of the values. */
const MAX_NAMED_VALUES = 2;

interface FacetFilterProps {
  label: string;
  icon?: LucideIcon;
  options: FacetOption[];
  value: string[];
  onChange: (next: string[]) => void;
  align?: "start" | "center" | "end";
  /**
   * The search box's placeholder; also its accessible name, less a trailing ellipsis. When omitted,
   * the placeholder reads "Search…" and the search is named `Search <label>` (e.g. "Search Status"),
   * so a screen reader hears which facet it is searching rather than a bare "Search".
   */
  searchPlaceholder?: string;
  emptyText?: string;
  /**
   * Whether the popover has a search box. Defaults to `true` when there are more than
   * {@link FACET_SEARCH_THRESHOLD} options. Force it on for a facet whose options load late.
   */
  searchable?: boolean;
  /**
   * The text the trigger shows for a selected value. Defaults to the matching option's `label`,
   * then to the raw value — so a value selected from a URL before its option has loaded still
   * reads as something.
   */
  formatValue?: (value: string) => string;
}

/**
 * The accessible name of a facet's search box: the caller's placeholder without its trailing
 * ellipsis, or "Search <label>" when the caller left the generic "Search…" placeholder in place.
 */
function searchName(label: string, searchPlaceholder: string | undefined): string {
  if (searchPlaceholder === undefined) return `Search ${label}`;
  return searchPlaceholder.replace(/\s*(…|\.\.\.)$/, "");
}

/** An option's search text: its label, its hint and its value, all three matchable. */
function facetSearchText(o: FacetOption): string {
  return `${o.label} ${o.hint ?? ""} ${o.value}`;
}

/**
 * What the selected trigger says after the facet's name: `A, B` for up to two values, or the count
 * of values past that (the caller renders it as `Name · N`). Returns `null` with nothing selected.
 */
export function facetSummary(
  value: readonly string[],
  labelOf: (value: string) => string,
): { kind: "values"; text: string } | { kind: "count"; count: number } | null {
  if (value.length === 0) return null;
  if (value.length > MAX_NAMED_VALUES) return { kind: "count", count: value.length };
  return { kind: "values", text: value.map(labelOf).join(", ") };
}

/**
 * The option list inside the popover, with a search box above it when `searchable`. Its own
 * component so the query lives and dies with the open list; toggling an option keeps the popover,
 * and the query, as they are.
 */
function FacetCommand({
  name,
  placeholder,
  emptyText,
  options,
  selected,
  searchable,
  listRef,
  onToggle,
}: {
  name: string;
  placeholder: string;
  emptyText: string;
  options: FacetOption[];
  selected: Set<string>;
  searchable: boolean;
  listRef: React.RefObject<HTMLDivElement | null>;
  onToggle: (value: string) => void;
}) {
  const search = useCommandSearch(options, facetSearchText);
  return (
    <Command
      label={name}
      search={search.search}
      onSearchChange={search.onSearchChange}
      filteredItems={search.results}
    >
      {searchable && <CommandInput placeholder={placeholder} className="text-ui-sm" />}
      {/* A facet's rows toggle a SET of values, so the listbox is multi-select and each row
          reports membership as `aria-selected` (#6734). The check box below is drawing only.
          Without a search box the popover focuses this list on open (`listRef`): the list itself
          takes the arrow keys and Enter, so a short facet stays fully keyboard-operable. */}
      <CommandList ref={listRef} multiselectable className="p-1">
        <CommandEmpty>{emptyText}</CommandEmpty>
        <CommandGroup>
          {search.results.map((o) => {
            const isOn = selected.has(o.value);
            return (
              <CommandItem
                key={o.value}
                onSelect={() => onToggle(o.value)}
                selected={isOn}
                aria-label={rowAccessibleName(o.label, o.hint, o.count)}
                className="h-8 gap-2 py-0 text-ui-md"
              >
                <span
                  aria-hidden
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
                  <CountFigure className="ml-auto truncate">{o.hint}</CountFigure>
                )}
                {o.count !== undefined && (
                  <CountFigure className={cn("shrink-0", !o.hint && "ml-auto")}>
                    {String(o.count)}
                  </CountFigure>
                )}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

/**
 * A multi-select facet dropdown. Selecting toggles and the popover stays open. Once something is
 * selected, the trigger names it and a sibling × clears this facet alone.
 */
export function FacetFilter({
  label,
  icon: Icon,
  options,
  value,
  onChange,
  align = "start",
  searchPlaceholder,
  emptyText = "No matches.",
  searchable,
  formatValue,
}: FacetFilterProps) {
  const [open, setOpen] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const selected = new Set(value);
  const hasSearch = searchable ?? options.length > FACET_SEARCH_THRESHOLD;

  /** Adds `v` to the selection, or removes it when already there. */
  function toggle(v: string) {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange([...next]);
  }

  /** The trigger's text for one selected value. */
  function labelOf(v: string): string {
    if (formatValue) return formatValue(v);
    return options.find((o) => o.value === v)?.label ?? v;
  }

  const summary = facetSummary(value, labelOf);
  const active = summary !== null;

  return (
    <div
      data-slot="facet-filter"
      data-state={active ? "active" : "idle"}
      className="inline-flex max-w-full items-stretch"
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className={cn(
                "min-w-0 gap-1.5 text-ui-md",
                active
                  ? "border-r-0 border-border-strong bg-surface-muted text-text-primary hover:bg-surface-muted"
                  : "text-text-secondary",
              )}
            >
              {Icon && <Icon size={14} />}
              {summary === null ? (
                <span>{label}</span>
              ) : summary.kind === "values" ? (
                <>
                  <span className="text-text-secondary">{label}:</span>{" "}
                  <span className="max-w-48 truncate">{summary.text}</span>
                </>
              ) : (
                <>
                  <span className="text-text-secondary">{label}</span>{" "}
                  <span aria-hidden className="text-text-tertiary">
                    ·
                  </span>{" "}
                  <span className="font-mono tabular-nums">{summary.count}</span>{" "}
                  <span className="sr-only">selected</span>
                </>
              )}
              {!active && <ChevronDown size={13} className="text-text-tertiary" />}
            </Button>
          }
        />
        <PopoverContent
          align={align}
          className="w-60 p-0"
          // With a search box, the default (first tabbable: the box) is right; without one, focus
          // the option list so the arrow keys work at once.
          initialFocus={hasSearch ? undefined : listRef}
        >
          <FacetCommand
            name={searchName(label, searchPlaceholder)}
            placeholder={searchPlaceholder ?? "Search…"}
            emptyText={emptyText}
            options={options}
            selected={selected}
            searchable={hasSearch}
            listRef={listRef}
            onToggle={toggle}
          />
        </PopoverContent>
      </Popover>
      {active && (
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={`Clear ${label}`}
          className="border-l-0 border-border-strong bg-surface-muted text-text-secondary hover:bg-surface-muted hover:text-text-primary"
          onClick={(event) => {
            // The × unmounts with the selection, so hand focus to the trigger beside it rather
            // than dropping a keyboard user back at the top of the page.
            const trigger = event.currentTarget.previousElementSibling;
            onChange([]);
            if (trigger instanceof HTMLElement) trigger.focus();
          }}
        >
          <X size={13} aria-hidden />
        </Button>
      )}
    </div>
  );
}
