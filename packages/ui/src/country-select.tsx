"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import flags from "react-phone-number-input/flags";

import { cn } from "./utils";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./command";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { COUNTRY_OPTIONS, countryName } from "./countries";

interface CountrySelectProps {
  /** Selected ISO 3166-1 alpha-2 code (e.g. "BG"), or "" when unset. */
  value: string;
  onChange: (code: string) => void;
  id?: string;
  disabled?: boolean;
  placeholder?: string;
  /** Renders the error border/ring when the field is invalid. */
  invalid?: boolean;
}

/**
 * Standalone, searchable country combobox (company location) over the full
 * country list, with flags. Styled to match our squared `SelectTrigger`; stores
 * the ISO-2 code and integrates with a react-hook-form Controller via
 * `value`/`onChange`.
 */
export function CountrySelect({
  value,
  onChange,
  id,
  disabled,
  placeholder = "Select a country",
  invalid,
}: CountrySelectProps) {
  const [open, setOpen] = React.useState(false);
  const popupRef = React.useRef<HTMLDivElement>(null);
  const Flag = value ? flags[value as keyof typeof flags] : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            id={id}
            aria-haspopup="listbox"
            aria-expanded={open}
            data-error={invalid || undefined}
            disabled={disabled}
            className={cn(
              "border-input flex h-9 w-full items-center justify-between gap-2 rounded-none border bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow]",
              "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
              "data-[error=true]:border-destructive data-[error=true]:ring-destructive/20",
              "disabled:cursor-not-allowed disabled:opacity-50",
              !value && "text-muted-foreground",
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              {Flag && (
                <span className="flex h-4 w-6 shrink-0 overflow-hidden rounded-sm bg-foreground/10 [&_svg]:size-full">
                  <Flag title={countryName(value)} />
                </span>
              )}
              <span className="truncate">
                {value ? countryName(value) : placeholder}
              </span>
            </span>
            <ChevronDownIcon className="size-4 shrink-0 opacity-50" />
          </button>
        }
      />
      {/* F033: the list stays mounted through its exit animation, sitting over the field below the
          picker. A click there during that window landed in the closing list, and when the close
          completed focus was sent back to this trigger, so what the user then typed went nowhere.
          A closing list now takes no pointer input, and focus returns to the trigger only if it is
          still inside the list (or nowhere) — never pulled off a field the user already moved to. */}
      <PopoverContent
        // Keeps the LAST popup element rather than nulling it on unmount: the focus decision is made
        // as the popup goes away, and it must still be able to ask "was focus inside it?".
        ref={(el: HTMLDivElement | null) => {
          if (el) popupRef.current = el;
        }}
        finalFocus={() => returnFocusToTrigger(popupRef.current)}
        className="w-[--anchor-width] min-w-[260px] p-0 data-[closed]:pointer-events-none"
      >
        {/* cmdk points the input's aria-labelledby at its own hidden <label>, whose text is this
            prop. Left empty, that reference resolves to "" and blocks the placeholder fallback, so
            the search is an unnamed combobox to a screen reader (#5803). */}
        <Command label="Search country">
          <CommandInput placeholder="Search country…" />
          <CommandList>
            <CommandEmpty>No country found.</CommandEmpty>
            <CommandGroup>
              {COUNTRY_OPTIONS.map((c) => {
                const ItemFlag = flags[c.code as keyof typeof flags];
                return (
                  <CommandItem
                    key={c.code}
                    value={c.name}
                    className="gap-2"
                    onSelect={() => {
                      onChange(c.code);
                      setOpen(false);
                    }}
                  >
                    {ItemFlag && (
                      <span className="flex h-4 w-6 shrink-0 overflow-hidden rounded-sm bg-foreground/10 [&_svg]:size-full">
                        <ItemFlag title={c.name} />
                      </span>
                    )}
                    <span className="flex-1 text-sm">{c.name}</span>
                    <CheckIcon
                      className={cn(
                        "ml-auto size-4",
                        c.code === value ? "opacity-100" : "opacity-0",
                      )}
                    />
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Whether closing the country list should send focus back to its trigger: yes when focus is still
 * inside the list, or has fallen to the page body; no when the user has already moved it to another
 * control — returning it then would swallow what they type next (F033).
 */
export function returnFocusToTrigger(popup: HTMLElement | null): boolean {
  const active = popup?.ownerDocument.activeElement ?? null;
  if (!active || active === popup?.ownerDocument.body) return true;
  return popup?.contains(active) ?? true;
}
