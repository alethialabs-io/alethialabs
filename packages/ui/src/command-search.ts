// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The ONE ranker behind every `@repo/ui/command` search (#6145).
//
// Base UI's Autocomplete filters with a yes/no `filter` and keeps matches in their original order,
// so it cannot rank. cmdk ranked with a fuzzy scorer, which was the other problem: "zz" listed htz3,
// htz2 and azdemo in the project switcher (F038, #6114), rows the user did not type and could not
// see a reason for. So ranking lives here, once: exact, then prefix, then the start of a later word,
// then a plain substring, and nothing else. Every consumer passes the ranked rows to `Command` as
// `filteredItems`, and `Command` turns Base UI's own filtering off.

import * as React from "react";

/** Characters that start a new "word" inside a search text: whitespace and `- _ . /`. */
const WORD_BREAK = /[\s\-_./]+/u;

/**
 * How well `text` matches what was typed (`search`): 1 for an exact match, 0.9 for a prefix, 0.8
 * for the start of a later word, 0.5 for a plain substring, and 0 (hidden) for anything else,
 * including a scattered-letter match. Case-insensitive; surrounding whitespace is ignored. An empty
 * search matches everything at 1.
 */
export function rankMatch(text: string, search: string): number {
  const query = search.trim().toLowerCase();
  if (query === "") return 1;
  const value = text.trim().toLowerCase();
  if (value === query) return 1;
  if (value.startsWith(query)) return 0.9;
  if (value.split(WORD_BREAK).some((word) => word.startsWith(query))) return 0.8;
  if (value.includes(query)) return 0.5;
  return 0;
}

/**
 * The items that match `search`, best match first. `toSearchText` gives each item its ONE search
 * string (a label, or a label plus keywords): what is matched is that string, never the row's
 * rendered text. Items with equal scores keep their input order, and an empty search keeps every
 * item in input order.
 *
 * `isDisabled`, when given and only while something is typed, sinks every row that cannot be run
 * below every row that can (each side keeping its own order). `Command` highlights the first row it
 * renders, and Enter runs the highlighted row, so a disabled best match would otherwise sit under
 * the highlight and swallow Enter; cmdk skipped such rows, and this keeps that. An EMPTY search
 * returns the input order exactly, disabled rows included: a list's deliberate order (the node
 * palette's group order, say) must not shift with which rows happen to be disabled, and with
 * nothing typed there is no best match to protect.
 */
export function rankItems<T>(
  items: readonly T[],
  search: string,
  toSearchText: (item: T) => string,
  isDisabled?: (item: T) => boolean,
): T[] {
  const blank = search.trim() === "";
  return items
    .map((item, index) => ({
      item,
      index,
      score: blank ? 1 : rankMatch(toSearchText(item), search),
      disabled: !blank && isDisabled?.(item) ? 1 : 0,
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => a.disabled - b.disabled || b.score - a.score || a.index - b.index)
    .map((row) => row.item);
}

/**
 * `results` split into labelled runs, each run keeping its rows' rank order, and the runs ordered
 * by their best row: the group holding the best match comes first, and an empty search keeps the
 * input order. Groups with no matching row are absent, so a caller never renders an empty heading.
 */
export function groupResults<T, G>(
  results: readonly T[],
  groupOf: (item: T) => G,
): { group: G; items: T[] }[] {
  const groups: { group: G; items: T[] }[] = [];
  for (const item of results) {
    const key = groupOf(item);
    const run = groups.find((g) => g.group === key);
    if (run) run.items.push(item);
    else groups.push({ group: key, items: [item] });
  }
  return groups;
}

/** What `useCommandSearch` hands a `Command`: its query, the setter, and the ranked rows. */
export interface CommandSearch<T> {
  /** What is typed in the search box. Pass as `Command`'s `search`. */
  search: string;
  /** Pass as `Command`'s `onSearchChange`. */
  onSearchChange: (search: string) => void;
  /** `items` ranked against `search` by `rankItems`. Render these, and pass them as `filteredItems`. */
  results: T[];
}

/** Options for `useCommandSearch`. */
export interface CommandSearchOptions<T> {
  /**
   * Pass when the list lives in a dialog or popover that stays mounted: the query then resets each
   * time `open` turns true, so a reopened list starts from an empty search (and not while it is
   * closing, which would flash the full list during the exit animation).
   */
  open?: boolean;
  /** Rows that cannot be run; they rank after every row that can (see `rankItems`). */
  isDisabled?: (item: T) => boolean;
}

/** Owns a `Command`'s search query and ranks `items` against it with `rankItems`. */
export function useCommandSearch<T>(
  items: readonly T[],
  toSearchText: (item: T) => string,
  { open, isDisabled }: CommandSearchOptions<T> = {},
): CommandSearch<T> {
  const [search, setSearch] = React.useState("");
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSearch("");
  }
  const results = React.useMemo(
    () => rankItems(items, search, toSearchText, isDisabled),
    [items, search, toSearchText, isDisabled],
  );
  return { search, onSearchChange: setSearch, results };
}
