"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Members — toolbar (count / invite) + filter bar + a bulk bar, over the shared
// DataTable. Real members + pending invitations, filtered SERVER-SIDE by the `members.page` GET
// procedure (rows + facets), prefetched by the route with the `members.gate` read that decides the
// toolbar (#6129). Inline role change, suspend/reactivate (real PDP grant revoke), remove, invite
// and cancel all go through `useActionMutation`: each row shows its own pending state, and the
// list is invalidated when the write settles.

import type { CellContext, ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Plus, Shield, Users } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { setMemberSuspended } from "@/app/server/actions/members";
import { ConfirmDialog } from "@/components/alerts/confirm-dialog";
import { ClassificationControl } from "@/components/classification/classification-control";
import { RegionError } from "@/components/errors/region-error";
import { useAssignmentsForKind } from "@/lib/query/use-classification-query";
import type { AssignedValue } from "@/lib/queries/classification";
import { DataTable } from "@/components/data-table";
import { InviteMemberDialog } from "@/components/settings/members/invite-member-dialog";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import type { ActionResult } from "@/lib/actions/result";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import {
  useMembersGateQuery,
  useMembersPageQuery,
} from "@/lib/query/use-members-query";
import { orpc } from "@/lib/rpc/client";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useMembersFilters } from "@/lib/stores/use-settings-filters";
import { formatRelative } from "@repo/format";
import { Button } from "@repo/ui/button";
import { DisabledReason } from "@repo/ui/disabled-reason";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import { EmptyState } from "@repo/ui/empty";
import { FacetFilter } from "@repo/ui/facet-filter";
import { FilterBar, FilterBarReset } from "@repo/ui/filter-bar";
import { FilterSearch } from "@repo/ui/filter-search";
import { MultiCombobox } from "@repo/ui/multi-combobox";
import { PageToolbar } from "@repo/ui/page-toolbar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/select";
import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import { authClient } from "@/lib/auth/client";
import { type OrgRole, toOrgRole } from "@/lib/authz/org-access-control";
import { BUILT_IN_ROLE_LABELS, roleDisplayName } from "@/lib/authz/registry";
import { userInitials } from "@/lib/user-display";
import {
  ASSIGNABLE_ROLE_OPTIONS,
  DEFAULT_MEMBERS_FILTERS,
  MEMBER_ROLE_FILTER_OPTIONS,
  MEMBER_STATUS_OPTIONS,
  type MemberRowView,
  normalizeMembersQuery,
} from "./members-filters";
import { viaAuth } from "./auth-action";
import { PeopleListSkeleton } from "./people-skeleton";

// A member's lifecycle state is not one of the product statuses `statusTier()` knows —
// "suspended" would fall through to `idle` by accident rather than by decision — so the tier
// is stated here and the SHARED badge renders it. This replaces a file-local `StatusBadge`
// that collided by name with @repo/ui's and with the one in billing/transactions-table.tsx.
const MEMBER_STATUS_TIER: Record<MemberRowView["status"], StatusTier> = {
  active: "active",
  pending: "pending",
  suspended: "idle",
};

/** The grayscale pill for one member's lifecycle state. */
function MemberStatusBadge({ status }: { status: MemberRowView["status"] }) {
  return (
    <StatusBadge
      status={status}
      tier={MEMBER_STATUS_TIER[status]}
      label={<span className="capitalize">{status}</span>}
    />
  );
}

/**
 * What one row's actions menu is a menu FOR — the second half of its accessible name.
 *
 * Every row's trigger used to be called just "Manage", which is the defect
 * `e2e/audit/destructive.spec.ts` names in its own header: N identically-named controls, so a
 * locator resolves one of them and records the verdict against whichever it happened to be. Two
 * readers are hurt by it and both are served here:
 *
 *   · a screen-reader user, who hears "Manage" N times down a column and cannot tell which person
 *     each button belongs to;
 *   · anything that has to REACH a specific row — `destructive-actions.yaml` carries one entry per
 *     control, and `Cancel invitation` exists only on an invitation's menu while `Reactivate` exists
 *     only on a suspended member's, so a chain that opens "the first Manage" opens the wrong menu
 *     for two of the four row controls and withholds their verdict.
 *
 * The KIND comes before the name so the prefix is selectable on its own ("Manage member …",
 * "Manage suspended member …", "Manage invitation …") without any fixture having to be named.
 */
function rowMenuSubject(r: MemberRowView): string {
  if (r.kind !== "member") return `invitation ${r.name}`;
  return r.status === "suspended"
    ? `suspended member ${r.name}`
    : `member ${r.name}`;
}

/**
 * A destructive members action a person has asked for but not yet confirmed.
 *
 * SIX of this table's controls reached the mutation on a bare click — removing a member (1),
 * cancelling an invitation (2), suspending (3), reactivating (4), and the two bulk actions (5, 6) —
 * which is why the union below has six variants. Each is recorded in
 * `apps/console/destructive-actions.yaml` (`members.*`), and each now opens the console's ONE
 * confirmation, `ConfirmDialog`. Held as a single discriminated union rather than six booleans: the
 * dialog is one component, so its copy has to be derived from one value, and six independent flags
 * make "two dialogs open at once" representable.
 */
type PendingMemberAction =
  | { kind: "remove"; memberId: string; who: string }
  | { kind: "cancel-invite"; invitationId: string; who: string }
  | { kind: "suspend"; memberId: string; who: string }
  | { kind: "reactivate"; memberId: string; who: string }
  | { kind: "bulk-remove"; count: number }
  | { kind: "bulk-suspend"; count: number };

interface ConfirmCopy {
  title: string;
  description: string;
  confirmLabel: string;
}

/**
 * What the confirmation holds before anything has been asked for.
 *
 * Never painted — a closed `AlertDialog` renders no content at all — but the dialog is mounted from
 * the first render, so the fields have to hold something, and an empty title on an
 * `AlertDialogTitle` is a nameless dialog rather than an unused one.
 */
const CLOSED_COPY: ConfirmCopy = {
  title: "Confirm this change?",
  description: "",
  confirmLabel: "Confirm",
};

/**
 * The confirmation copy for one pending action.
 *
 * Every `confirmLabel` is distinct from the dialog's own "Cancel" escape AND from the trigger that
 * opened it. Two buttons reading "Cancel" is the one confirmation that means nothing, and a confirm
 * label identical to the trigger gives the destructive-action spec's locator two matches on one
 * page — an ambiguity it reports as a withheld verdict rather than a pass. Cancelling an invitation
 * is therefore confirmed with "Revoke invitation": the menu item says "Cancel invitation" and the
 * way out says "Cancel", so a third spelling is what keeps all three legible.
 */
function confirmCopy(pending: PendingMemberAction): ConfirmCopy {
  switch (pending.kind) {
    case "remove":
      return {
        title: "Remove this member?",
        description: `${pending.who} loses access to this organization immediately, along with every grant their membership carried. Re-adding them means a fresh invitation they have to accept.`,
        confirmLabel: "Remove member",
      };
    case "cancel-invite":
      return {
        title: "Cancel this invitation?",
        description: `The pending invitation for ${pending.who} stops working. If they have not accepted yet, the link in their email dies with it and they need a new invitation.`,
        confirmLabel: "Revoke invitation",
      };
    case "suspend":
      return {
        title: "Suspend this member?",
        description: `${pending.who} keeps their membership and role but loses every access grant until they are reactivated. Anything they have running is unaffected; they simply cannot reach it.`,
        confirmLabel: "Suspend member",
      };
    case "reactivate":
      return {
        title: "Reactivate this member?",
        description: `${pending.who} regains the access grants their role carries and can reach this organization again.`,
        confirmLabel: "Reactivate member",
      };
    case "bulk-remove":
      return {
        title: "Remove the selected people?",
        description: `${pending.count} selected ${pending.count === 1 ? "row" : "rows"} — members lose access to this organization and pending invitations are revoked. Owners in the selection are skipped. This runs row by row and is not undone by closing the page.`,
        confirmLabel: "Remove selected",
      };
    case "bulk-suspend":
      return {
        title: "Suspend the selected members?",
        description: `Every active, non-owner member in the ${pending.count} selected ${pending.count === 1 ? "row" : "rows"} loses their access grants until they are reactivated one at a time.`,
        confirmLabel: "Suspend selected",
      };
  }
}

/**
 * A compact, borderless Select for a member's role.
 *
 * This is a FORM control that performs a mutation, not a filter — the console filter
 * standard bans Radix Selects from filter bars, and the role FILTER above is a facet. The two
 * option lists are deliberately different: `owner` is filterable but not assignable.
 */
function RoleSelect({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        size="sm"
        aria-label="Role"
        className="h-7 w-auto gap-1 border-0 bg-transparent px-2 text-xs font-medium shadow-none hover:bg-muted focus-visible:ring-0"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ASSIGNABLE_ROLE_OPTIONS.map((ro) => (
          <SelectItem key={ro} value={ro} className="text-xs">
            {BUILT_IN_ROLE_LABELS[ro]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ── STABLE CELLS (#5023) ─────────────────────────────────────────────────────────────────────
//
// Every cell below is a MODULE-LEVEL component, and the columns that name them are memoized on
// `canManage` alone. That is the whole fix, and the reason is how the table renders a cell:
// `DataTable` calls TanStack's `flexRender(columnDef.cell, ctx)`, which for a function is
// `React.createElement(cell, ctx)` — the `cell` function IS the component type. The columns used to
// be array literals rebuilt on every render of `MembersTable`, so every `({ row }) => …` was a NEW
// type each time, and React unmounted and re-created every cell on every re-render. A window-focus
// refetch, a `useSession` tick, the collaboration or classification query settling, a debounced
// keystroke, a checkbox ticked in another row — any of them tore down the cell holding an open Base
// UI row menu, which closed it under the person using it. `e2e/audit/destructive.spec.ts` saw the
// same thing as a withheld verdict ("not rendered … for this persona").
//
// What changes from render to render — the selection, the pending-action writer, the role writer,
// the classification map — travels through `MembersCellsContext` instead. A context change
// RE-RENDERS a consumer; only a new component type REMOUNTS it.
// `tests/components/members-table-stable-cells.test.tsx` holds a real menu open across both.

/** The per-render state the table's cells read, delivered by context so no cell type changes. */
interface MembersCells {
  canManage: boolean;
  /** Row keys with a write in flight: their controls are disabled until it settles. */
  busy: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  toggle: (key: string) => void;
  askFor: (action: PendingMemberAction) => void;
  changeRole: (memberId: string, value: string) => void;
  classMap: Record<string, AssignedValue[]>;
}

const MembersCellsContext = createContext<MembersCells | null>(null);

/**
 * The classification map before its query answers. One module-level object rather than a `{}`
 * default in the destructure, which would be a new value every render and re-render every cell
 * through the context for nothing.
 */
const NO_CLASSIFICATIONS: Record<string, AssignedValue[]> = {};

/** The members table's cell state; a cell rendered outside `MembersTable` is a wiring defect. */
function useMembersCells(): MembersCells {
  const ctx = useContext(MembersCellsContext);
  if (!ctx) {
    throw new Error("A members-table cell rendered outside MembersCellsContext.");
  }
  return ctx;
}

/** The row-selection checkbox. */
function SelectCell({ row }: CellContext<MemberRowView, unknown>) {
  const { selected, toggle } = useMembersCells();
  const r = row.original;
  return (
    <input
      type="checkbox"
      aria-label={`Select ${r.name}`}
      className="size-4 cursor-pointer accent-ink align-middle"
      checked={selected.has(r.key)}
      onChange={() => toggle(r.key)}
    />
  );
}

/** Avatar, name, address and (members only) classification chips. */
function MemberCell({ row }: CellContext<MemberRowView, unknown>) {
  const { canManage, classMap } = useMembersCells();
  const r = row.original;
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-muted font-mono text-ui-xs text-muted-foreground">
        {r.avatar}
      </span>
      {/* THE MEMBER CELL WRAPS, so the row's LAST column stays on screen. Table cells are
          `whitespace-nowrap`, and the shell's table wrapper is `overflow-x: clip` (no scroll
          container, by design — `@repo/ui/table`), so one long monospace address used to set
          this column's width and push Status, Last active and the "Manage …" trigger every
          per-row destructive control hangs off past the clip edge. Measured on the release
          gate at 1280px: all three clipped, unreachable by a person and by Playwright alike.
          `break-all` on the address gives the column a small min-content width, so the
          table's auto layout shrinks this column instead of overflowing. */}
      <div className="flex min-w-0 flex-col whitespace-normal">
        <span className="flex items-center gap-1.5 break-words text-foreground">
          {r.name}
          {r.isYou && (
            <span className="rounded-full border px-1.5 py-px font-mono text-ui-3xs uppercase tracking-wide text-muted-foreground">
              You
            </span>
          )}
        </span>
        <span className="break-all font-mono text-ui-2xs text-muted-foreground">
          {r.meta}
        </span>
        {/* Classification (Workstream B) — members only (not invites). */}
        {r.kind === "member" && (
          <ClassificationControl
            kind="member"
            id={r.refId}
            canEdit={canManage}
            initialAssignments={classMap[r.refId]}
            className="mt-1"
            compact
          />
        )}
      </div>
    </div>
  );
}

/** The owner's fixed label, an editable role for a manageable member, plain text otherwise. */
function RoleCell({ row }: CellContext<MemberRowView, unknown>) {
  const { canManage, changeRole, busy } = useMembersCells();
  const r = row.original;
  if (r.kind === "member" && r.role === "owner") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 text-xs font-medium text-foreground">
        <Shield size={13} className="text-muted-foreground" />
        {BUILT_IN_ROLE_LABELS.owner}
      </span>
    );
  }
  if (r.kind === "member" && canManage) {
    return (
      <RoleSelect
        value={r.role}
        disabled={r.status === "suspended" || busy.has(r.key)}
        onChange={(v) => changeRole(r.refId, v)}
      />
    );
  }
  return (
    <span className="px-2 text-xs font-medium text-foreground">
      {roleDisplayName(r.role)}
    </span>
  );
}

/** A row's team chips, or a dashed "No team" placeholder. */
function TeamsCell({ row }: CellContext<MemberRowView, unknown>) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {row.original.teams.length > 0 ? (
        row.original.teams.map((t) => (
          <span
            key={t}
            className="whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-ui-2xs text-muted-foreground"
          >
            {t}
          </span>
        ))
      ) : (
        <span className="rounded-full border border-dashed px-2 py-0.5 font-mono text-ui-2xs text-text-tertiary">
          No team
        </span>
      )}
    </div>
  );
}

/** The row's lifecycle pill. */
function StatusCell({ row }: CellContext<MemberRowView, unknown>) {
  return <MemberStatusBadge status={row.original.status} />;
}

/** When the member was last active, already formatted by the row builder against the page's `asOf`. */
function ActivityCell({ row }: CellContext<MemberRowView, unknown>) {
  return (
    <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
      {row.original.activity}
    </span>
  );
}

/**
 * One row's "Manage …" menu. Every item only RECORDS the action (`askFor`); the table's one
 * `ConfirmDialog` decides whether it happens. The owner's row has no menu.
 */
function ActionsCell({ row }: CellContext<MemberRowView, unknown>) {
  const { askFor, busy } = useMembersCells();
  const r = row.original;
  if (r.kind === "member" && r.role === "owner") return null;
  // A row whose write is in flight takes no second one: the menu is closed to it and the trigger
  // says so, which is also the double-submit guard for a confirmation answered twice.
  const pending = busy.has(r.key);
  return (
    <div className="text-right">
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={pending}
          render={
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={`Manage ${rowMenuSubject(r)}`}
              aria-busy={pending || undefined}
              disabled={pending}
            >
              <MoreHorizontal size={16} />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-44">
          {r.kind === "member" ? (
            <>
              {r.status === "suspended" ? (
                <DropdownMenuItem
                  onClick={() =>
                    askFor({ kind: "reactivate", memberId: r.refId, who: r.name })
                  }
                >
                  Reactivate
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  onClick={() =>
                    askFor({ kind: "suspend", memberId: r.refId, who: r.name })
                  }
                >
                  Suspend
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() =>
                  askFor({ kind: "remove", memberId: r.refId, who: r.name })
                }
              >
                Remove from organization
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() =>
                askFor({
                  kind: "cancel-invite",
                  invitationId: r.refId,
                  who: r.name,
                })
              }
            >
              Cancel invitation
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * The table's columns. They depend on `canManage` ONLY — whether the select and actions columns
 * exist at all — and every `cell` is a module-level component, so the same `canManage` always
 * yields the same component types.
 */
function membersColumns(canManage: boolean): ColumnDef<MemberRowView>[] {
  const selectCols: ColumnDef<MemberRowView>[] = canManage
    ? [{ id: "select", header: "", enableSorting: false, cell: SelectCell }]
    : [];
  const actionCols: ColumnDef<MemberRowView>[] = canManage
    ? [{ id: "actions", header: "", enableSorting: false, cell: ActionsCell }]
    : [];
  return [
    ...selectCols,
    { id: "member", header: "Member", enableSorting: false, cell: MemberCell },
    { id: "role", header: "Role", enableSorting: false, cell: RoleCell },
    { id: "teams", header: "Teams", enableSorting: false, cell: TeamsCell },
    { accessorKey: "status", header: "Status", cell: StatusCell },
    {
      accessorKey: "activity",
      header: "Last active",
      enableSorting: false,
      cell: ActivityCell,
    },
    ...actionCols,
  ];
}

/** Every read the members page shows; each write below invalidates all of them. */
const MEMBERS_READS = [orpc.members.key()];

/** One row of a bulk write: the row's key, and the write to run for it. */
interface BulkStep {
  key: string;
  run: () => Promise<ActionResult<unknown>>;
}

/**
 * Runs a bulk write row by row and answers once: success when every row succeeded, otherwise a
 * `conflict` naming how many did not — the rows that did are already written, and the list is
 * invalidated either way.
 */
async function runBulk(steps: BulkStep[]): Promise<ActionResult<{ done: number }>> {
  let failed = 0;
  for (const step of steps) {
    const result = await step.run();
    if (!result.ok) failed += 1;
  }
  if (failed > 0) {
    return {
      ok: false,
      error: {
        kind: "conflict",
        message: `${failed} of ${steps.length} selected ${steps.length === 1 ? "row" : "rows"} could not be changed.`,
      },
    };
  }
  return { ok: true, data: { done: steps.length } };
}

/** Settings · Members: the filterable members + invitations table and its confirmations. */
export function MembersTable() {
  // The gate is the SERVER's answer, prefetched with the rows (#6129, F017): whether this org may
  // manage members (the select and actions columns) and invite, and why not. `canManage` unlocks
  // on a known `true` only, so a gate that has not answered renders no management column at all.
  const gate = useMembersGateQuery();
  const canManage = gate.data?.canManage === true;

  // Filter state: the store is the source of truth, the URL mirrors it (shareable views),
  // and the free text is debounced. The role filter is a FACET, not the Radix Select it used
  // to be — Selects are banned from filter bars by the console filter standard.
  const filters = useMembersFilters((s) => s.filters);
  const set = useMembersFilters((s) => s.set);
  const reset = useMembersFilters((s) => s.reset);
  const urlRead = useFilterUrlSync(useMembersFilters, DEFAULT_MEMBERS_FILTERS);
  // Seeded from the URL, so a pasted `?search=…&statuses=…` asks first for the key the route
  // prefetched — not `{statuses}` alone, which it did not (#4999, as #4980 on `~/runners`).
  const search = useDebouncedValue(filters.search, 250, { urlRead });
  const query = useMemo(
    () => normalizeMembersQuery(filters, search),
    [filters, search],
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Nothing in this table mutates on a bare click any more; the click records what was asked for
  // and the ConfirmDialog at the bottom of the render decides whether it happens.
  const [pending, setPending] = useState<PendingMemberAction | null>(null);
  // The copy the confirmation is RENDERING, which outlives `pending` by exactly one close.
  //
  // The dialog is mounted for the life of the table and driven by `open` (the other six
  // `ConfirmDialog` call sites in the console all do this; unmounting a base-ui `AlertDialog.Root`
  // mid-close kills the exit transition and drops focus to `<body>` instead of returning it to the
  // row). That makes `pending === null` a state the dialog still RENDERS in for the length of the
  // close, so the question cannot be derived from `pending` alone without blanking out as it fades.
  // This is presentation only — `pending` remains the single source of truth for what happens and
  // for whether the dialog is open — and `askFor` is the only writer of either, so the two cannot
  // drift apart.
  const [copy, setCopy] = useState<ConfirmCopy>(CLOSED_COPY);
  const askFor = useCallback((action: PendingMemberAction) => {
    setCopy(confirmCopy(action));
    setPending(action);
  }, []);

  // Filtered SERVER-SIDE: `members.page` narrows members AND pending invitations in SQL and returns
  // the status/role/team facets counted over the org's UNFILTERED universe, so an option never
  // disappears as you select it. The normalized query IS the input, and `keepPreviousData` (in the
  // hook) keeps the table's rows across a filter change — `isPlaceholderData` is what marks them
  // stale while the next answer loads.
  const page = useMembersPageQuery(query);
  // The list is BUSY while what it shows may not answer the URL and the bar: before the link has
  // been read into the store, before the first answer, while the rows are the previous query's
  // placeholder, and while a typed search is still inside its debounce. Exposed as `aria-busy` on
  // the table's root, so assistive tech — and the audit's F8 read, which refuses a busy read as an
  // answer (#4980) — can tell an answer from a stand-in (#4999). The dim below stays the
  // placeholder half only: dimming the first paint of every visit would flash a correct page.
  const busy =
    !urlRead || page.isPending || page.isPlaceholderData || filters.search !== search;
  // Memoized, not `data ?? []` inline: a fresh `[]` every render would re-key the batched
  // classification query below on each paint while the fetch is still in flight.
  const members = useMemo(() => page.data?.members ?? [], [page.data]);
  const invites = useMemo(() => page.data?.invitations ?? [], [page.data]);
  // WHO is viewing and WHEN the rows were read both come from the payload, never from this
  // renderer: the route dehydrates the payload, so the server render and the hydrating client
  // read the same two values and produce the same markup (#5377, React #418).
  const viewerUserId = page.data?.viewerUserId;
  const asOf = page.data?.asOf;
  /** Every member + pending invitation in the org — what tells onboarding from an empty filter. */
  const total = page.data?.total ?? 0;

  // ── Writes (ADR 0005 D4) ──────────────────────────────────────────────────────────────────
  // Every one invalidates every members read when it settles, and every one is pending while in
  // flight — the row it acts on is disabled (`busy` below), which is the double-submit guard.
  const roleChange = useActionMutation(
    ({ memberId, role }: { memberId: string; role: OrgRole }) =>
      viaAuth(() => authClient.organization.updateMemberRole({ memberId, role })),
    { invalidates: MEMBERS_READS, successMessage: "Role updated" },
  );
  const removal = useActionMutation(
    ({ memberId }: { memberId: string }) =>
      viaAuth(() => authClient.organization.removeMember({ memberIdOrEmail: memberId })),
    { invalidates: MEMBERS_READS, successMessage: "Member removed" },
  );
  const cancellation = useActionMutation(
    ({ invitationId }: { invitationId: string }) =>
      viaAuth(() => authClient.organization.cancelInvitation({ invitationId })),
    { invalidates: MEMBERS_READS, successMessage: "Invitation revoked" },
  );
  const suspension = useActionMutation(setMemberSuspended, {
    invalidates: MEMBERS_READS,
    successMessage: (d) => (d.suspended ? "Member suspended" : "Member reactivated"),
  });
  const bulk = useActionMutation(
    ({ steps }: { steps: BulkStep[]; keys: string[] }) => runBulk(steps),
    {
      invalidates: MEMBERS_READS,
      successMessage: (d) => `${d.done} ${d.done === 1 ? "row" : "rows"} updated`,
      onSuccess: () => setSelected(new Set()),
    },
  );

  const changeRole = useCallback(
    (memberId: string, value: string) => {
      const role = toOrgRole(value);
      if (!role || role === "owner") return;
      roleChange.mutate({ memberId, role });
    },
    [roleChange],
  );

  /** The row keys a write is in flight for — `m:<member id>` / `i:<invitation id>`. */
  const busyKeys = useMemo(() => {
    const keys = new Set<string>();
    if (roleChange.isPending && roleChange.variables) keys.add(`m:${roleChange.variables.memberId}`);
    if (removal.isPending && removal.variables) keys.add(`m:${removal.variables.memberId}`);
    if (suspension.isPending && suspension.variables) keys.add(`m:${suspension.variables.memberId}`);
    if (cancellation.isPending && cancellation.variables) {
      keys.add(`i:${cancellation.variables.invitationId}`);
    }
    if (bulk.isPending && bulk.variables) for (const k of bulk.variables.keys) keys.add(k);
    return keys;
  }, [
    roleChange.isPending,
    roleChange.variables,
    removal.isPending,
    removal.variables,
    suspension.isPending,
    suspension.variables,
    cancellation.isPending,
    cancellation.variables,
    bulk.isPending,
    bulk.variables,
  ]);

  const rows = useMemo<MemberRowView[]>(() => {
    const memberRows: MemberRowView[] = members.map((m) => ({
      id: `m:${m.id}`,
      key: `m:${m.id}`,
      kind: "member",
      refId: m.id,
      name: m.name?.trim() || m.email,
      meta: m.email,
      avatar: userInitials({ name: m.name, email: m.email }),
      role: m.role,
      teams: m.teams,
      status: m.status === "suspended" ? "suspended" : "active",
      activity: m.lastActiveAt
        ? formatRelative(m.lastActiveAt, asOf ? new Date(asOf) : undefined)
        : "—",
      isYou: m.userId === viewerUserId,
    }));
    const inviteRows: MemberRowView[] = invites.map((i) => ({
      id: `i:${i.id}`,
      key: `i:${i.id}`,
      kind: "invite",
      refId: i.id,
      name: i.email,
      meta: `invited by ${i.inviterName}`,
      avatar: userInitials({ email: i.email }),
      role: i.role,
      teams: [],
      status: "pending",
      activity: "— invited",
      isYou: false,
    }));
    return [...memberRows, ...inviteRows];
  }, [members, invites, viewerUserId, asOf]);

  // One batched query hydrates every member row's classification chips (invites aren't
  // classifiable). Keyed on the member row id (member.id).
  const { data: classMap = NO_CLASSIFICATIONS } = useAssignmentsForKind(
    "member",
    rows.filter((r) => r.kind === "member").map((r) => r.refId),
  );

  // The server already applied the query, so the rows ARE the result. The facet counts come
  // from that read's second, unfiltered pass — never from these rows.
  const filtered = rows;
  const counts = useMemo(() => {
    const tally = (options: { value: string; count: number }[]) => {
      const out: Record<string, number> = {};
      for (const o of options) out[o.value] = o.count;
      return out;
    };
    return {
      statuses: tally(page.data?.facets.statuses ?? []),
      roles: tally(page.data?.facets.roles ?? []),
      teams: tally(page.data?.facets.teams ?? []),
    };
  }, [page.data]);
  const activeFilters = countActiveFilters(filters, DEFAULT_MEMBERS_FILTERS);

  const toggle = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /** Removes the selected rows: members leave the org, invitations are revoked; owners are skipped. */
  function bulkRemove() {
    const picked = filtered.filter((x) => selected.has(x.key));
    const steps: BulkStep[] = [];
    for (const r of picked) {
      if (r.kind === "member") {
        if (r.role === "owner") continue;
        steps.push({
          key: r.key,
          run: () =>
            viaAuth(() => authClient.organization.removeMember({ memberIdOrEmail: r.refId })),
        });
      } else {
        steps.push({
          key: r.key,
          run: () => viaAuth(() => authClient.organization.cancelInvitation({ invitationId: r.refId })),
        });
      }
    }
    bulk.mutate({ steps, keys: steps.map((step) => step.key) });
  }

  /** Suspends every active, non-owner member in the selection. */
  function bulkSuspend() {
    const steps: BulkStep[] = filtered
      .filter((r) => selected.has(r.key))
      .filter((r) => r.kind === "member" && r.role !== "owner" && r.status === "active")
      .map((r) => ({
        key: r.key,
        run: () => setMemberSuspended({ memberId: r.refId, suspended: true }),
      }));
    bulk.mutate({ steps, keys: steps.map((step) => step.key) });
  }

  // Memoized on `canManage` alone, and every `cell` is a module-level component (see STABLE
  // CELLS above): a re-render of this table must never hand DataTable a new cell TYPE.
  const columns = useMemo(() => membersColumns(canManage), [canManage]);
  const cells = useMemo<MembersCells>(
    () => ({ canManage, busy: busyKeys, selected, toggle, askFor, changeRole, classMap }),
    [canManage, busyKeys, selected, toggle, askFor, changeRole, classMap],
  );

  // Pending is the route skeleton's shape, not a second, different one (B2). The route prefetches
  // the first answer, so this is reached only when the cache was evicted under the page.
  if (page.isPending) {
    return <PeopleListSkeleton facets={2} columns={canManage ? 7 : 5} />;
  }
  // A failed first load is an ERROR, never "No members yet" (B4).
  if (page.isError && page.data === undefined) {
    return (
      <RegionError
        title="Couldn't load members"
        description="The member list didn't load. Nothing about your organization changed."
        onRetry={() => void page.refetch()}
      />
    );
  }

  const inviteButton = (
    <Button size="sm">
      <Plus size={13} />
      Invite member
    </Button>
  );
  // Invite is offered when the server says this org may invite; otherwise the SAME button is shown
  // disabled with the reason, which names the plan the badge shows (F017, F057) — no upsell modal
  // behind an enabled control. Before the gate answers there is no button at all.
  const inviteAction = gate.data ? (
    gate.data.canInvite ? (
      <InviteMemberDialog trigger={inviteButton} />
    ) : (
      <DisabledReason reason={gate.data.inviteBlockedReason}>{inviteButton}</DisabledReason>
    )
  ) : undefined;
  const bulkPending = bulk.isPending;

  return (
    <div aria-busy={busy}>
      <PageToolbar
        className="mb-4"
        description="Organization members and pending invitations."
        count={filtered.length}
        actions={inviteAction}
      />
      {/* The stat-card strip that used to sit here is gone (banned by CLAUDE.md §6). Every
          figure it carried — seats, active, pending, suspended — is now the Status facet's
          option counts, computed over the same unfiltered rows, so nothing was lost. */}
      <FilterBar>
        <FilterSearch
          value={filters.search}
          onChange={(v) => set("search", v)}
          placeholder="Search name or email…"
          className="w-[240px] max-w-[380px] flex-1"
        />
        <FacetFilter
          label="Status"
          icon={Users}
          options={MEMBER_STATUS_OPTIONS.map((o) => ({
            value: o.value,
            label: o.label,
            hint: String(counts.statuses[o.value] ?? 0),
          }))}
          value={filters.statuses}
          onChange={(next) => set("statuses", next)}
          searchPlaceholder="Filter status…"
          emptyText="No statuses."
        />
        <FacetFilter
          label="Role"
          icon={Shield}
          options={MEMBER_ROLE_FILTER_OPTIONS.map((o) => ({
            value: o.value,
            label: o.label,
            hint: String(counts.roles[o.value] ?? 0),
          }))}
          value={filters.roles}
          onChange={(next) => set("roles", next)}
          searchPlaceholder="Filter role…"
          emptyText="No roles."
        />
        {/* Teams are an open-ended entity list, so this is a searchable combobox rather than
            a fixed facet popover — the same split the standard draws for authors/projects. */}
        {Object.keys(counts.teams).length > 0 && (
          <MultiCombobox
            placeholder="All teams"
            icon={Users}
            className="w-[180px]"
            options={Object.keys(counts.teams)
              .sort()
              .map((t) => ({
                value: t,
                label: t,
                hint: String(counts.teams[t] ?? 0),
              }))}
            value={filters.teams}
            onChange={(next) => set("teams", next)}
          />
        )}
        <FilterBarReset count={activeFilters} onReset={reset} />
      </FilterBar>

      {/* bulk bar */}
      {canManage && selected.size > 0 && (
        <div className="mb-3 flex items-center justify-between gap-4 rounded-md border border-foreground bg-muted py-[9px] pl-4 pr-[14px]">
          <div className="flex items-center gap-3 text-ui-sm text-foreground">
            <span>
              <b className="font-semibold">{selected.size}</b> selected
            </span>
            <button
              type="button"
              className="font-mono text-ui-xs text-muted-foreground hover:text-foreground"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </button>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={bulkPending}
              onClick={() =>
                askFor({ kind: "bulk-suspend", count: selected.size })
              }
            >
              Suspend
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={bulkPending}
              onClick={() =>
                askFor({ kind: "bulk-remove", count: selected.size })
              }
            >
              Remove
            </Button>
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <EmptyState
          className="border border-border bg-surface-sunken"
          icon={<Users />}
          title={total === 0 ? "No members yet" : "No matching members"}
          description={
            total === 0
              ? "Invite a teammate to collaborate in this organization."
              : "No member or invitation matches these filters."
          }
          action={
            total === 0 ? undefined : (
              <Button variant="outline" size="sm" onClick={reset}>
                Clear filters
              </Button>
            )
          }
        />
      ) : (
        <div
          className={page.isPlaceholderData ? "opacity-60 transition-opacity" : undefined}
        >
          <MembersCellsContext.Provider value={cells}>
            <DataTable columns={columns} data={filtered} pageSize={20} />
          </MembersCellsContext.Provider>
        </div>
      )}

      {/* The one confirmation every destructive control on this table passes through. It stays
          MOUNTED and is driven by `open` — the shape the console's other six `ConfirmDialog` call
          sites already use (environments-view, policies-panel, channels-panel, node-inspector,
          pending-changes-bar). The pending action is still the single source of open state, so the
          two cannot disagree; what conditional mounting cost was the close itself. `onOpenChange`
          clears `pending` in the same tick, so an unmounted Root was torn out while still `open`:
          base-ui's exit transition never ran, and focus had nothing to return to — the
          `DropdownMenuItem` that opened the dialog is gone by then, so the keyboard landed on
          `<body>` instead of the row. `copy` is what survives that close (see its declaration).
          `ConfirmDialog` closes itself before calling `onConfirm`, so the handler below still reads
          the action it was opened for. */}
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
        title={copy.title}
        description={copy.description}
        confirmLabel={copy.confirmLabel}
        onConfirm={() => {
          if (!pending) return;
          switch (pending.kind) {
            case "remove":
              removal.mutate({ memberId: pending.memberId });
              break;
            case "cancel-invite":
              cancellation.mutate({ invitationId: pending.invitationId });
              break;
            case "suspend":
              suspension.mutate({ memberId: pending.memberId, suspended: true });
              break;
            case "reactivate":
              suspension.mutate({ memberId: pending.memberId, suspended: false });
              break;
            case "bulk-remove":
              bulkRemove();
              break;
            case "bulk-suspend":
              bulkSuspend();
              break;
          }
        }}
      />

    </div>
  );
}
