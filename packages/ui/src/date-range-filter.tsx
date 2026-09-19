"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Filter 2 — the precise range picker. A Popover whose trigger shows the resolved range
// ("May 27, 11pm – Jun 26"). The panel stacks a range-mode Calendar, Start/End date+time
// inputs, an Apply button, and a full IANA timezone Select.
//
// Model: the committed range is two UTC instants; the chosen timezone is purely the
// *display* basis. Every field (calendar day, date input, time input) is derived from the
// instants via `formatInTimeZone`, and every edit recomposes the instant with
// `fromZonedTime(wallClock, tz)`. So changing the timezone keeps the instants and just
// re-renders the wall-clock. Generic/reusable: `value` / `onChange` only.

import { format } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { CalendarDays } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  type DateRange,
  formatRangeLabel,
  localTimeZone,
  timeZoneOptions,
} from "./range";
import { Button } from "./button";
import { Calendar, type CalendarRange } from "./calendar";
import { Label } from "./label";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

interface DateRangeFilterProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
  /** Initial display timezone (IANA); defaults to the browser's. */
  defaultTimeZone?: string;
}

// What the trigger says for the one frame before mount. The control's own name rather than a
// blank, so the button keeps a sensible width and a reader is never shown a wall-clock computed
// in a zone that is not theirs.
const TRIGGER_PLACEHOLDER = "Date range";

/** A bare date/time input pair styled to match the design system. */
function inputCls() {
  return "h-8 min-w-0 flex-1 rounded-sm border border-input bg-transparent px-2 text-[12px] text-text-primary outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/50";
}

export function DateRangeFilter({
  value,
  onChange,
  defaultTimeZone,
}: DateRangeFilterProps) {
  const [open, setOpen] = useState(false);
  const [tz, setTz] = useState(defaultTimeZone ?? localTimeZone());
  const [from, setFrom] = useState<Date>(value.from);
  const [to, setTo] = useState<Date>(value.to);
  // THE TRIGGER LABEL IS NOT SERVER-RENDERABLE, so it is not rendered until mount.
  //
  // `formatRangeLabel(value, tz)` reads two things the server does not have: the viewer's
  // timezone (`localTimeZone()` resolves to the SERVER's zone during SSR) and, at every call
  // site, a `value` whose default end is the wall clock to the minute. Both render into a text
  // node, so the server's string and the hydrating client's string differ — React #418,
  // "text content did not match". It is intermittent only because the two halves of a CI run
  // share a clock and a zone and have to straddle a minute boundary to disagree; against a UTC
  // server and a real browser it is the common case, not the rare one.
  //
  // Gating on mount is the fix rather than `suppressHydrationWarning`, which suppresses the
  // REPORT and leaves the server's wrong wall-clock on screen. The committed range is unchanged
  // and the popover is closed during SSR, so nothing else here reaches the server's HTML.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const tzOptions = useMemo(() => timeZoneOptions(), []);

  // Reset the draft to the committed value whenever the popover (re)opens.
  useEffect(() => {
    if (open) {
      setFrom(value.from);
      setTo(value.to);
    }
  }, [open, value.from, value.to]);

  // Derived display fields (all in the chosen tz).
  const fromDate = formatInTimeZone(from, tz, "yyyy-MM-dd");
  const fromTime = formatInTimeZone(from, tz, "HH:mm");
  const toDate = formatInTimeZone(to, tz, "yyyy-MM-dd");
  const toTime = formatInTimeZone(to, tz, "HH:mm");
  // Floating local-midnight markers so the Calendar highlights the right civil day.
  const calRange: CalendarRange = {
    from: new Date(`${fromDate}T00:00:00`),
    to: new Date(`${toDate}T00:00:00`),
  };

  /** Compose a wall-clock "YYYY-MM-DD HH:mm" in the chosen tz into a UTC instant. */
  const combine = (dateStr: string, timeStr: string) =>
    fromZonedTime(`${dateStr} ${timeStr}:00`, tz);

  /** Calendar selection — keep each end's time-of-day, move only its civil day. */
  function onSelectRange(range: CalendarRange | undefined) {
    if (range?.from)
      setFrom(combine(format(range.from, "yyyy-MM-dd"), fromTime));
    if (range?.to) setTo(combine(format(range.to, "yyyy-MM-dd"), toTime));
  }

  /** Commit (swapping if the user picked end before start). */
  function apply() {
    let f = from;
    let t = to;
    if (f > t) [f, t] = [t, f];
    onChange({ from: f, to: t });
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" className="gap-1.5">
            <CalendarDays size={14} />
            {mounted ? formatRangeLabel(value, tz) : TRIGGER_PLACEHOLDER}
          </Button>
        }
      />
      <PopoverContent align="end" className="w-auto p-0">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <Calendar
            mode="range"
            defaultMonth={calRange.from}
            selected={calRange}
            onSelect={onSelectRange}
            numberOfMonths={1}
          />

          <div className="flex flex-col gap-3 border-t border-border p-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-[11px] uppercase tracking-wide text-text-tertiary">
                Start
              </Label>
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFrom(combine(e.target.value, fromTime))}
                  className={inputCls()}
                />
                <input
                  type="time"
                  value={fromTime}
                  onChange={(e) => setFrom(combine(fromDate, e.target.value))}
                  className={inputCls()}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="text-[11px] uppercase tracking-wide text-text-tertiary">
                End
              </Label>
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={toDate}
                  onChange={(e) => setTo(combine(e.target.value, toTime))}
                  className={inputCls()}
                />
                <input
                  type="time"
                  value={toTime}
                  onChange={(e) => setTo(combine(toDate, e.target.value))}
                  className={inputCls()}
                />
              </div>
            </div>

            <Button type="submit" size="sm" className="w-full">
              Apply
            </Button>

            <Select value={tz} onValueChange={setTz}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-[280px]">
                {tzOptions.map((z, i) => (
                  <SelectItem key={z} value={z}>
                    {i === 0 ? `Local (${z})` : z}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
