"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Check, ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import { Button } from "@repo/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@repo/ui/command";
import { useCommandSearch } from "@repo/ui/command-search";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/popover";
import { cn } from "@repo/ui/utils";

export interface ComboOption {
  value: string;
  label: string;
}

/** An option's search text: its visible label, for the shared ranker. */
const optionSearchText = (o: ComboOption): string => o.label;

/** A searchable single-select (Command-in-Popover), mirroring the org switcher. */
export function Combobox({
  options,
  value,
  onChange,
  placeholder = "Select…",
  empty = "No results.",
}: {
  options: ComboOption[];
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  empty?: string;
}) {
  const [open, setOpen] = useState(false);
  // Ranked by the shared ranker; the query starts empty each time the popover opens.
  const optionSearch = useCommandSearch(options, optionSearchText, open);
  const selected = options.find((o) => o.value === value);
  // The placeholder is an instruction ("Select a permission…"), so it doubles as the control's
  // purpose once the trailing ellipsis is dropped.
  const purpose = placeholder.replace(/[.…]+$/u, "");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          // NO `role="combobox"`: there is no text input and no owned listbox on this button — the
          // search field lives inside the popup — and base-ui's popover already reports
          // `aria-haspopup="dialog"` and `aria-expanded` for it. The role's real cost was that it
          // is name-from-author-only, which left this control with NO accessible name at all while
          // its label sat visibly inside it.
          //
          // A name is written only for the selected state. Empty, the button reads
          // "Select a permission…" — the placeholder IS the visible text and already states the
          // purpose, so an `aria-label` there would be a second copy to keep in sync. Selected, it
          // reads "Kubernetes read", which never says it is a picker; the name adds the purpose and
          // keeps the visible text inside it (WCAG 2.5.3).
          <Button
            type="button"
            variant="outline"
            aria-label={selected ? `${purpose}: ${selected.label}` : undefined}
            className="w-full justify-between font-normal"
          >
            <span
              className={cn("truncate", !selected && "text-muted-foreground")}
            >
              {selected?.label ?? placeholder}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        }
      />
      <PopoverContent
        className="w-[var(--anchor-width)] p-0"
        align="start"
      >
        {/* The search inside the popup is named for the same purpose as its trigger. */}
        <Command
          label={purpose}
          search={optionSearch.search}
          onSearchChange={optionSearch.onSearchChange}
          filteredItems={optionSearch.results}
        >
          <CommandInput placeholder={placeholder} />
          <CommandList>
            <CommandEmpty>{empty}</CommandEmpty>
            <CommandGroup>
              {optionSearch.results.map((o) => (
                <CommandItem
                  key={o.value}
                  onSelect={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === o.value ? "opacity-100" : "opacity-0",
                    )}
                  />
                  {o.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
