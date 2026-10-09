"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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
import { CountFigure } from "./count-pill";
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
}

/**
 * The accessible name of a facet's search box: the caller's placeholder without its trailing
 * ellipsis, or "Search <label>" when the caller left the generic "Search…" placeholder in place.
 */
function searchName(label: string, searchPlaceholder: string | undefined): string {
  if (searchPlaceholder === undefined) return `Search ${label}`;
  return searchPlaceholder.replace(/\s*(…|\.\.\.)$/, "");
}

/** A searchable multi-select dropdown. Selecting toggles; the popover stays open. */
export function FacetFilter({
  label,
  icon: Icon,
  options,
  value,
  onChange,
  align = "start",
  searchPlaceholder,
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
      <PopoverTrigger
        render={
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
        }
      />
      <PopoverContent align={align} className="w-[240px] p-0">
        {/* cmdk points the input's aria-labelledby at its own hidden <label>, whose text is this
            prop. Left empty, that reference resolves to "" and blocks the placeholder fallback, so
            the search is an unnamed combobox to a screen reader (#5803). */}
        <Command label={searchName(label, searchPlaceholder)}>
          <CommandInput
            placeholder={searchPlaceholder ?? "Search…"}
            className="text-[12.5px]"
          />
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
                    <span className="truncate text-text-primary">
                      {o.label}
                    </span>
                    {o.hint && (
                      <CountFigure className="ml-auto truncate">
                        {o.hint}
                      </CountFigure>
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
