"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Members — stats + toolbar (tabs / search / role filter / invite) + a bulk
// bar, over the shared DataTable (sortable + paginated). Real members (getMembers, with
// team names) + pending invitations (getInvitations); inline role change, suspend/
// reactivate (real PDP grant revoke), remove, invite, cancel. The page header + gate
// live in members/page.tsx.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Plus, Shield, Users } from "lucide-react";
import { useParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  getInvitations,
  getMembers,
  setMemberSuspended,
} from "@/app/server/actions/members";
import { getCollaborationAccess } from "@/app/server/actions/billing";
import { ConfirmDialog } from "@/components/alerts/confirm-dialog";
import { ClassificationControl } from "@/components/classification/classification-control";
import { useAssignmentsForKind } from "@/lib/query/use-classification-query";
import { DataTable } from "@/components/data-table";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import { InviteMemberDialog } from "@/components/settings/members/invite-member-dialog";
import { UpgradeDialog } from "@/components/settings/upgrade/upgrade-dialog";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { qk } from "@/lib/query/keys";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useMembersFilters } from "@/lib/stores/use-settings-filters";
import { formatRelative } from "@repo/format";
import { Button } from "@repo/ui/button";
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
import { Skeleton } from "@repo/ui/skeleton";
import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import { authClient } from "@/lib/auth/client";
import { toOrgRole } from "@/lib/authz/org-access-control";
import { userInitials } from "@/lib/user-display";
import {
  ASSIGNABLE_ROLE_OPTIONS,
  DEFAULT_MEMBERS_FILTERS,
  filterMembers,
  MEMBER_ROLE_FILTER_OPTIONS,
  MEMBER_STATUS_OPTIONS,
  type MemberRowView,
  membersFacetCounts,
  normalizeMembersQuery,
} from "./members-filters";

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
        className="h-7 w-auto gap-1 border-0 bg-transparent px-2 text-xs font-medium capitalize shadow-none hover:bg-muted focus-visible:ring-0"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ASSIGNABLE_ROLE_OPTIONS.map((ro) => (
          <SelectItem key={ro} value={ro} className="text-xs capitalize">
            {ro}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function MembersTable() {
  const canManage = useEntitlement("organizations");
  const { data: session } = authClient.useSession();
  const myId = session?.user?.id;
  const { org } = useParams<{ org: string }>();
  const qc = useQueryClient();

  // Filter state: the store is the source of truth, the URL mirrors it (shareable views),
  // and the free text is debounced. The role filter is a FACET, not the Radix Select it used
  // to be — Selects are banned from filter bars by the console filter standard.
  const filters = useMembersFilters((s) => s.filters);
  const set = useMembersFilters((s) => s.set);
  const reset = useMembersFilters((s) => s.reset);
  useFilterUrlSync(useMembersFilters, DEFAULT_MEMBERS_FILTERS);
  const search = useDebouncedValue(filters.search);
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

  const membersQuery = useQuery({
    queryKey: qk.members(org),
    queryFn: () => getMembers(),
  });
  const invitesQuery = useQuery({
    queryKey: ["members", org, "invitations"] as const,
    queryFn: () => getInvitations(),
  });
  // Inviting is the paid (Pro) value — viewing members is always open. The billing-backed
  // `canInvite` gate (card-backed/paid) decides whether the Invite button opens the form
  // or the Pro upsell; the server enforces it again in `beforeCreateInvitation`.
  const collaboration = useQuery({
    queryKey: ["members", org, "collaboration-access"] as const,
    queryFn: () => getCollaborationAccess(),
    staleTime: 60_000,
  });
  const canInvite = collaboration.data?.canInvite ?? false;
  // Memoized, not `data ?? []` inline: a fresh `[]` every render would re-key the batched
  // classification query below on each paint while the fetch is still in flight.
  const members = useMemo(() => membersQuery.data ?? [], [membersQuery.data]);
  const invites = useMemo(() => invitesQuery.data ?? [], [invitesQuery.data]);

  const load = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["members", org] });
  }, [qc, org]);

  const changeRole = useCallback(
    async (memberId: string, value: string) => {
      const next = toOrgRole(value);
      if (!next) return;
      await authClient.organization.updateMemberRole({ memberId, role: next });
      load();
    },
    [load],
  );
  const removeMember = useCallback(
    async (memberId: string) => {
      await authClient.organization.removeMember({ memberIdOrEmail: memberId });
      load();
    },
    [load],
  );
  const cancelInvite = useCallback(
    async (invitationId: string) => {
      await authClient.organization.cancelInvitation({ invitationId });
      load();
    },
    [load],
  );
  const suspend = useCallback(
    async (memberId: string, next: boolean) => {
      try {
        await setMemberSuspended(memberId, next);
        load();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Couldn't update the member.",
        );
      }
    },
    [load],
  );

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
      activity: m.lastActiveAt ? formatRelative(m.lastActiveAt) : "—",
      isYou: m.userId === myId,
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
  }, [members, invites, myId]);

  // One batched query hydrates every member row's classification chips (invites aren't
  // classifiable). Keyed on the member row id (member.id).
  const { data: classMap = {} } = useAssignmentsForKind(
    "member",
    rows.filter((r) => r.kind === "member").map((r) => r.refId),
  );

  const filtered = useMemo(() => filterMembers(rows, query), [rows, query]);
  // Facet counts are over the UNFILTERED rows, so an option cannot disappear as you select it.
  const counts = useMemo(() => membersFacetCounts(rows), [rows]);
  const activeFilters = countActiveFilters(filters, DEFAULT_MEMBERS_FILTERS);

  const toggle = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  async function bulkRemove() {
    for (const r of filtered.filter((x) => selected.has(x.key))) {
      try {
        if (r.kind === "member") {
          if (r.role === "owner") continue;
          await authClient.organization.removeMember({
            memberIdOrEmail: r.refId,
          });
        } else {
          await authClient.organization.cancelInvitation({
            invitationId: r.refId,
          });
        }
      } catch {
        /* best-effort */
      }
    }
    setSelected(new Set());
    load();
  }

  async function bulkSuspend() {
    for (const r of filtered.filter((x) => selected.has(x.key))) {
      if (r.kind === "member" && r.role !== "owner" && r.status === "active") {
        try {
          await setMemberSuspended(r.refId, true);
        } catch {
          /* best-effort */
        }
      }
    }
    setSelected(new Set());
    load();
  }

  const selectCols: ColumnDef<MemberRowView>[] = canManage
    ? [
        {
          id: "select",
          header: "",
          enableSorting: false,
          cell: ({ row }) => (
            <input
              type="checkbox"
              aria-label={`Select ${row.original.name}`}
              className="size-4 cursor-pointer accent-ink align-middle"
              checked={selected.has(row.original.key)}
              onChange={() => toggle(row.original.key)}
            />
          ),
        },
      ]
    : [];
  const actionCols: ColumnDef<MemberRowView>[] = canManage
    ? [
        {
          id: "actions",
          header: "",
          enableSorting: false,
          cell: ({ row }) => {
            const r = row.original;
            if (r.kind === "member" && r.role === "owner") return null;
            return (
              <div className="text-right">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label={`Manage ${rowMenuSubject(r)}`}
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
                              askFor({
                                kind: "reactivate",
                                memberId: r.refId,
                                who: r.name,
                              })
                            }
                          >
                            Reactivate
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            onClick={() =>
                              askFor({
                                kind: "suspend",
                                memberId: r.refId,
                                who: r.name,
                              })
                            }
                          >
                            Suspend
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() =>
                            askFor({
                              kind: "remove",
                              memberId: r.refId,
                              who: r.name,
                            })
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
          },
        },
      ]
    : [];

  const columns: ColumnDef<MemberRowView>[] = [
    ...selectCols,
    {
      id: "member",
      header: "Member",
      enableSorting: false,
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-muted font-mono text-ui-xs text-muted-foreground">
              {r.avatar}
            </span>
            <div className="flex min-w-0 flex-col">
              <span className="flex items-center gap-1.5 text-foreground">
                {r.name}
                {r.isYou && (
                  <span className="rounded-full border px-1.5 py-px font-mono text-ui-3xs uppercase tracking-wide text-muted-foreground">
                    You
                  </span>
                )}
              </span>
              <span className="font-mono text-ui-2xs text-muted-foreground">
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
      },
    },
    {
      id: "role",
      header: "Role",
      enableSorting: false,
      cell: ({ row }) => {
        const r = row.original;
        if (r.kind === "member" && r.role === "owner") {
          return (
            <span className="inline-flex items-center gap-1.5 px-2 text-xs font-medium text-foreground">
              <Shield size={13} className="text-muted-foreground" />
              Owner
            </span>
          );
        }
        if (r.kind === "member" && canManage) {
          return (
            <RoleSelect
              value={r.role}
              disabled={r.status === "suspended"}
              onChange={(v) => void changeRole(r.refId, v)}
            />
          );
        }
        return (
          <span className="px-2 text-xs font-medium capitalize text-foreground">
            {r.role}
          </span>
        );
      },
    },
    {
      id: "teams",
      header: "Teams",
      enableSorting: false,
      cell: ({ row }) => (
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
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <MemberStatusBadge status={row.original.status} />,
    },
    {
      accessorKey: "activity",
      header: "Last active",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
          {row.original.activity}
        </span>
      ),
    },
    ...actionCols,
  ];

  if (membersQuery.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div>
      <PageToolbar
        className="mb-4"
        description="Organization members and pending invitations."
        count={filtered.length}
        actions={
          canInvite ? (
            <InviteMemberDialog
              onInvited={load}
              trigger={
                <Button size="sm">
                  <Plus size={13} />
                  Invite member
                </Button>
              }
            />
          ) : (
            <UpgradeDialog
              feature="invite"
              trigger={
                <Button size="sm">
                  <Plus size={13} />
                  Invite member
                </Button>
              }
            />
          )
        }
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
              onClick={() =>
                askFor({ kind: "bulk-suspend", count: selected.size })
              }
            >
              Suspend
            </Button>
            <Button
              variant="ghost"
              size="sm"
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
          title={rows.length === 0 ? "No members yet" : "No matching members"}
          description={
            rows.length === 0
              ? "Invite a teammate to collaborate in this organization."
              : "No member or invitation matches these filters."
          }
          action={
            rows.length === 0 ? undefined : (
              <Button variant="outline" size="sm" onClick={reset}>
                Clear filters
              </Button>
            )
          }
        />
      ) : (
        <DataTable columns={columns} data={filtered} pageSize={20} />
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
              void removeMember(pending.memberId);
              break;
            case "cancel-invite":
              void cancelInvite(pending.invitationId);
              break;
            case "suspend":
              void suspend(pending.memberId, true);
              break;
            case "reactivate":
              void suspend(pending.memberId, false);
              break;
            case "bulk-remove":
              void bulkRemove();
              break;
            case "bulk-suspend":
              void bulkSuspend();
              break;
          }
        }}
      />

    </div>
  );
}
