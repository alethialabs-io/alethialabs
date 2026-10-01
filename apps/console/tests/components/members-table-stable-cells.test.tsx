// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AN OPEN ROW MENU SURVIVES A RE-RENDER OF THE MEMBERS TABLE (#5023).
//
// `DataTable` renders a cell through TanStack's `flexRender`, which for a function is
// `React.createElement(cell, ctx)` — the column's `cell` function IS the component type. The
// members table used to rebuild its column array literals on every render, so each re-render
// handed React a NEW type for every cell and every cell remounted: a window-focus refetch, a
// `useSession` tick or a checkbox ticked in another row closed the Base UI menu a person had open.
//
// This drives the REAL `MembersTable` (its data hooks are mocked, nothing else) and holds a real
// menu open — opened by a click, not `defaultOpen` — across the two re-render sources that matter:
// the page query answering again with an equal-but-new payload, and local state changing (a row's
// checkbox). What is asserted is the menu item's DOM node identity: a remounted cell renders a
// fresh, CLOSED menu, so the item disappears, and even a re-opened one would be a different node.
//
// Mutation check (done when this was written): restoring the inline `cell: ({ row }) => …`
// columns in `members-table.tsx` makes both tests fail at the identity assertion.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MembersTable } from "@/components/settings/members/members-table";

/** The members page the mocked query answers with; replaced wholesale to simulate a refetch. */
let pageData = buildPage();

/** A fresh payload with the same three rows — what a refetch returns when nothing changed. */
function buildPage() {
  return {
    members: [
      {
        id: "mem_owner",
        userId: "u_owner",
        name: "Grace Hopper",
        username: null,
        email: "grace@example.test",
        image: null,
        role: "owner",
        joinedAt: "2026-01-01T00:00:00.000Z",
        teams: [],
        status: "active",
        lastActiveAt: null,
      },
      {
        id: "mem_ada",
        userId: "u_ada",
        name: "Ada Lovelace",
        username: null,
        email: "ada@example.test",
        image: null,
        role: "member",
        joinedAt: "2026-01-02T00:00:00.000Z",
        teams: ["platform"],
        status: "active",
        lastActiveAt: null,
      },
      {
        id: "mem_linus",
        userId: "u_linus",
        name: "Linus Torvalds",
        username: null,
        email: "linus@example.test",
        image: null,
        role: "member",
        joinedAt: "2026-01-03T00:00:00.000Z",
        teams: [],
        status: "active",
        lastActiveAt: null,
      },
    ],
    invitations: [],
    resultCount: 3,
    total: 3,
    facets: { statuses: [], roles: [], teams: [] },
  };
}

vi.mock("next/navigation", () => ({
  useParams: () => ({ org: "acme" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/acme/settings/members",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/hooks/use-filter-url-sync", () => ({ useFilterUrlSync: () => {} }));
vi.mock("@/components/settings/enterprise-gate", () => ({
  useEntitlement: () => true,
}));
vi.mock("@/lib/auth/client", () => ({
  authClient: {
    // A NEW object every call, like a session hook that ticks: one more re-render source.
    useSession: () => ({ data: { user: { id: "u_owner" } } }),
    organization: {
      updateMemberRole: vi.fn(),
      removeMember: vi.fn(),
      cancelInvitation: vi.fn(),
    },
  },
}));
vi.mock("@/app/server/actions/members", () => ({
  setMemberSuspended: vi.fn(),
}));
vi.mock("@/app/server/actions/billing", () => ({
  getCollaborationAccess: vi.fn(async () => ({ canInvite: false })),
}));
vi.mock("@/lib/query/use-members-query", () => ({
  useMembersPageQuery: () => ({
    data: pageData,
    isPending: false,
    isPlaceholderData: false,
  }),
}));
vi.mock("@/lib/query/use-classification-query", () => ({
  useAssignmentsForKind: () => ({ data: undefined }),
}));
vi.mock("@/components/classification/classification-control", () => ({
  ClassificationControl: () => null,
}));
vi.mock("@/components/settings/members/invite-member-dialog", () => ({
  InviteMemberDialog: ({ trigger }: { trigger: ReactNode }) => trigger,
}));
vi.mock("@/components/settings/upgrade/upgrade-dialog", () => ({
  UpgradeDialog: ({ trigger }: { trigger: ReactNode }) => trigger,
}));

/** The table inside the query client it expects, as a fresh element on every call. */
function tree(client: QueryClient) {
  return (
    <QueryClientProvider client={client}>
      <MembersTable />
    </QueryClientProvider>
  );
}

/** Render the table and open Ada's row menu with a real click; returns the open menu's item. */
async function renderWithAdasMenuOpen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(tree(client));
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Manage member Ada Lovelace" }),
  );
  const item = await screen.findByRole("menuitem", { name: "Suspend" });
  return { ...view, client, item };
}

describe("MembersTable — an open row menu survives a re-render (#5023)", () => {
  beforeEach(() => {
    pageData = buildPage();
  });

  it("keeps the menu open when the members query answers again", async () => {
    const { rerender, client, item } = await renderWithAdasMenuOpen();

    // The refetch: an equal payload, but every object in it is new — what a window-focus refetch
    // or an invalidation after someone else's mutation delivers.
    pageData = buildPage();
    rerender(tree(client));

    expect(
      screen.queryByRole("menuitem", { name: "Suspend" }),
      "a re-render must not remount the cell holding the open menu — a remount closes it",
    ).toBe(item);
    expect(
      screen.getByRole("button", { name: "Manage member Ada Lovelace" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the menu open when another row's checkbox changes the selection", async () => {
    const { item } = await renderWithAdasMenuOpen();

    // State inside MembersTable: selecting Linus re-renders the table (and mounts the bulk bar).
    // `fireEvent.click` rather than `userEvent`, deliberately: a real pointer press outside an open
    // menu dismisses it by design, and that is not the behaviour under test — the re-render is.
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Linus Torvalds" }));
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: "Select Linus Torvalds" }),
      ).toBeChecked(),
    );
    expect(screen.getByText("selected")).toBeInTheDocument();

    expect(
      screen.queryByRole("menuitem", { name: "Suspend" }),
      "a selection change must not remount the cell holding the open menu",
    ).toBe(item);
  });

  it("still renders no menu for the owner's row, and one per other member", () => {
    // The guard on the guard: stable cells must not change WHAT is rendered per row.
    const client = new QueryClient();
    render(tree(client));
    expect(
      screen.queryByRole("button", { name: /Manage member Grace Hopper/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /^Manage member / }).map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Manage member Ada Lovelace", "Manage member Linus Torvalds"]);
  });
});
