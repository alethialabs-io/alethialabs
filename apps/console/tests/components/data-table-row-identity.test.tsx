// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A ROW'S IDENTITY IS ITS `id`, NOT ITS POSITION — and the thing that proves it is an open menu.
//
// `DataTable` keys `<TableRow>` and `<TableCell>` on TanStack's `row.id`, which defaults to the
// row's INDEX. So a list that comes back in a different order does not move rows in React's eyes:
// it hands position 1 a different row's data. Cells that render the same shape survive that with
// nothing but new text — which is why it went unnoticed — but a cell that renders NOTHING for one
// row kind (the owner's, in `members-table.tsx`) unmounts whatever moved into its place, and an
// open Base UI menu is unmounted with it.
//
// That is the second half of #4852: `members.suspend` withheld on a promotion run with its row
// menu shut, and the destructive audit could only report it as "the trigger {menuitem: "Suspend"}
// is not rendered … for this persona". The first half is the unordered read that makes the order
// change in the first place (`getMembers()`, tests/actions/members.test.ts).
//
// ── WHY THIS ASSERTS NODE IDENTITY AND A MOUNT COUNT, NOT "the menu is open" ────────────────────
//
// The menu below is `defaultOpen`, because Base UI's trigger does not open under jsdom's pointer
// events. That makes "is a Suspend item on screen?" the WRONG question: a remounted cell renders a
// second `defaultOpen` menu, so the broken table would answer yes. What separates the two is
// whether React KEPT the subtree — so the assertions are the DOM node's identity across the
// re-render and the number of times the cell mounted. Both are properties of the remount itself,
// which is what takes a real menu down.

import { render, screen } from "@testing-library/react";
import type { ColumnDef } from "@tanstack/react-table";
import { useEffect } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { DataTable } from "@/components/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";

/** A members-table row, cut down to the two things that matter here: an id and a row KIND. */
interface Row {
  id: string;
  name: string;
  kind: "owner" | "member";
}

/**
 * A row for one of the callers whose data carries no `id`. The property is declared (and left
 * unset) because `DataTable`'s `TData extends { id?: string }` is what the generic is inferred
 * against; the runtime rows below genuinely have no id, which is the case under test.
 */
interface AnonymousRow {
  id?: string;
  name: string;
}

const OWNER: Row = { id: "m:owner", name: "Grace", kind: "owner" };
const ADA: Row = { id: "m:ada", name: "Ada", kind: "member" };
const LINUS: Row = { id: "m:linus", name: "Linus", kind: "member" };

/** How many times each row's action cell has been mounted in the current test. */
const mounts = new Map<string, number>();

/** One row's Manage menu, counting its own mounts. */
function RowMenu({ name, open }: { name: string; open?: boolean }) {
  useEffect(() => {
    mounts.set(name, (mounts.get(name) ?? 0) + 1);
  }, [name]);
  return (
    <DropdownMenu defaultOpen={open}>
      <DropdownMenuTrigger
        render={
          <button type="button" aria-label={`Manage member ${name}`}>
            …
          </button>
        }
      />
      <DropdownMenuContent>
        <DropdownMenuItem>Suspend {name}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The members table's action column, reduced to its load-bearing shape: `null` for the owner's row
 * (members-table.tsx — `if (r.kind === "member" && r.role === "owner") return null`) and a menu for
 * every other row. Ada's is the one that starts open.
 */
const columns: ColumnDef<Row, unknown>[] = [
  { id: "member", header: "Member", cell: ({ row }) => row.original.name },
  {
    id: "actions",
    header: "",
    cell: ({ row }) =>
      row.original.kind === "owner" ? null : (
        <RowMenu name={row.original.name} open={row.original.id === ADA.id} />
      ),
  },
];

describe("DataTable row identity", () => {
  beforeEach(() => mounts.clear());

  it("keeps a row's open menu when the SAME rows come back in a different order", () => {
    // Ada sits at index 1, behind the owner.
    const { rerender } = render(
      <DataTable columns={columns} data={[OWNER, ADA, LINUS]} />,
    );
    const before = screen.getByRole("menuitem", { name: "Suspend Ada" });
    expect(mounts.get("Ada"), "premise: one render, one mount").toBe(1);

    // The refetch. Nothing about Ada changed — only where she is in the list. Index 1 now holds the
    // owner, whose action cell is `null`, so index-keyed rows unmount the cell holding her menu.
    rerender(<DataTable columns={columns} data={[ADA, OWNER, LINUS]} />);

    expect(
      mounts.get("Ada"),
      "a row that only MOVED must not be re-created — a remount takes its open menu with it",
    ).toBe(1);
    expect(
      screen.getByRole("menuitem", { name: "Suspend Ada" }),
      "and the menu React kept is the SAME element, not a second one rendered in its place",
    ).toBe(before);
  });

  it("still renders every row, in the order the data gives", () => {
    // The guard on the guard: `getRowId` decides what React KEEPS, and a bad one (a constant, a
    // colliding id) would collapse the list. Row ids are unique here and the order is the data's.
    render(<DataTable columns={columns} data={[ADA, OWNER, LINUS]} />);
    const names = screen
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.textContent?.replace("…", "").trim());
    expect(names).toEqual(["Ada", "Grace", "Linus"]);
  });

  it("falls back to the position for rows that carry no id", () => {
    // `TData extends { id?: string }` — the id is OPTIONAL, and the callers whose rows have none
    // must keep working exactly as they did. Nothing here can be identity-keyed, so what is pinned
    // is that every row still renders, in the data's order and under DISTINCT keys: `getRowId`
    // returning the same value twice (or `undefined`) is the way a fallback breaks, and it shows
    // up as rows collapsing into one.
    const anonymous: ColumnDef<AnonymousRow, unknown>[] = [
      { id: "member", header: "Member", cell: ({ row }) => row.original.name },
    ];
    render(
      <DataTable
        columns={anonymous}
        data={[{ name: "Ada" }, { name: "Linus" }]}
      />,
    );
    const names = screen
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.textContent?.trim());
    expect(names).toEqual(["Ada", "Linus"]);
  });
});
