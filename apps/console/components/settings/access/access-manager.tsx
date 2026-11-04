"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Access — an inheritance info-note, a toolbar (count · Add grant), the filter bar
// (search · scope · roles · effect), an inline grant builder with a live preview, and the grants
// table on the shared DataTable (sortable + paginated). The reads are the `members.grants` and `members.grantOptions` GET
// procedures, prefetched by the org route (#6129); the writes are `assignGrant` / `revokeGrant`
// through `useActionMutation`, and an `access` hint refreshes the list when someone else changes a
// grant. The page header lives in the settings shell; without the Enterprise `customRoles`
// entitlement the surface stays visible and shows the upsell.

import type { ColumnDef } from "@tanstack/react-table";
import { Info, Layers, MoreHorizontal, Plus, Shield, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
import {
  type AccessGrantRow,
  assignGrant,
  type GrantOptions,
  revokeGrant,
} from "@/app/server/actions/grants";
import { RegionError } from "@/components/errors/region-error";
import { isForbiddenRead } from "@/components/settings/members/people-reads";
import { PeopleListSkeleton } from "@/components/settings/members/people-skeleton";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { roleDisplayName } from "@/lib/authz/registry";
import {
  useAccessGrantsPageQuery,
  useGrantOptionsQuery,
} from "@/lib/query/use-access-grants-query";
import { orpc } from "@/lib/rpc/client";
import { lookup } from "@/lib/typed-object";
import { DataTable } from "@/components/data-table";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import { FeatureUpsell } from "@/components/settings/upgrade/feature-upsell";
// `SettingsSelect` survives here as a FORM control inside the grant builder. The console
// filter standard bans Radix Selects from FILTER BARS, where a multi-select facet is the
// right shape; picking one role to grant is a single-choice form field, which is what a
// Select is for. The toolbar's old "All scopes" Select is gone.
import { SettingsSelect } from "@/components/settings/settings-ui";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useAccessFilters } from "@/lib/stores/use-settings-filters";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@repo/ui/alert-dialog";
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
import { formatRelative } from "@repo/format";
import { MultiCombobox } from "@repo/ui/multi-combobox";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { StatusBadge } from "@repo/ui/status-badge";
import { cn } from "@repo/ui/utils";
import { userInitials } from "@/lib/user-display";
import {
  DEFAULT_ACCESS_FILTERS,
  EFFECT_OPTIONS,
  facetCounts,
  grantRoleLabel,
  normalizeAccessQuery,
  reachLabel,
  SCOPE_LEVEL,
} from "./access-filters";
import { AccessNoAccess } from "./access-no-access";
import { Combobox } from "./combobox";

/** Every read a grant write shows in: the grants list, the role catalog's grant counts. */
const GRANT_READS = [orpc.members.key()];

const SCOPE_OPTIONS = [
  { value: "org", label: "Entire organization" },
  { value: "project", label: "A Project" },
  { value: "runner", label: "A runner" },
  { value: "cloud_identity", label: "A cloud identity" },
];

/**
 * The Access surface. When `projectId` is given the grants list and the grant builder are scoped
 * to that single project (project-scoped Settings › Access); without it, the full org grants render.
 *
 * `customRoles` is the entitlement as the PAGE resolved it on the server (#5850). The workspace
 * store's copy is `null` until `fetchWorkspace()` answers after hydration, and `useEntitlement`
 * reads that `null` as "not entitled" — so an Enterprise org was shown the upsell, an empty state
 * with nothing marking it provisional, for as long as that round trip took. The audit's `settle()`
 * read it twice as a list of 0 rows. The server's answer is known at first paint; the store can
 * still turn the surface on later (an in-session upgrade), never off.
 */
export function AccessManager({
  projectId,
  customRoles = false,
  forbidden: forbiddenAtRender = false,
}: {
  projectId?: string;
  customRoles?: boolean;
  /** The route's prefetch was refused (`member:view`): the no-access render from the first paint. */
  forbidden?: boolean;
} = {}) {
  const storeEntitled = useEntitlement("customRoles");
  const entitled = customRoles || storeEntitled === true;

  // Filter state: the store is the source of truth, the URL mirrors it (shareable views),
  // and the free text is DEBOUNCED — this surface had none, so every keystroke re-ran the
  // whole predicate. Fifteen `useState` calls collapse to one store plus two dialog flags.
  const filters = useAccessFilters((s) => s.filters);
  const set = useAccessFilters((s) => s.set);
  const reset = useAccessFilters((s) => s.reset);
  const urlRead = useFilterUrlSync(useAccessFilters, DEFAULT_ACCESS_FILTERS);
  // Seeded from the URL once it is read, so a pasted `?search=…` asks first for the key the link
  // names rather than spending one debounce on the pristine one (#4999, members).
  const search = useDebouncedValue(filters.search, 250, { urlRead });
  const query = useMemo(
    () => normalizeAccessQuery(filters, search, projectId),
    [filters, search, projectId],
  );

  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<AccessGrantRow | null>(null);

  // Custom-scoped grants are Enterprise. Without the entitlement the page body is the upsell, so
  // both reads stay disabled; a route that already learned the viewer may not read them (forbidden)
  // does not ask again.
  //
  // Filtered SERVER-SIDE (#4890): the whole normalized query is the input, `members.grants`
  // narrows in SQL, and the scope/role/effect facets come back counted over the UNFILTERED
  // grants of the same scope — so an option never disappears the moment it is selected.
  const grantsQuery = useAccessGrantsPageQuery(query, entitled && !forbiddenAtRender);
  // The list is BUSY while what it shows may not answer the URL and the bar: before the link has
  // been read into the store, before the first answer, while the rows are the previous query's
  // placeholder, and while a typed search is still inside its debounce — the jobs, runners,
  // members, teams and activity lists' rule (#4980, #5494). `aria-busy` is what tells assistive
  // tech, and the audit's F8–F9 `settle()`, that the skeleton is loading rather than empty.
  const busy =
    !urlRead ||
    grantsQuery.isPending ||
    grantsQuery.isPlaceholderData ||
    filters.search !== search;
  const optionsQuery = useGrantOptionsQuery(entitled && !forbiddenAtRender);
  const options: GrantOptions | null = optionsQuery.data ?? null;
  // Forbidden is its own render (B4): the route's prefetch said so, or a live refetch did (a
  // viewer whose `member:view` went away while the page was open).
  const forbidden = forbiddenAtRender || isForbiddenRead(grantsQuery.error);

  // Resolve a scoped resource id → a friendly label via the option lists.
  const resourceLabel = useMemo(() => {
    const map = new Map<string, string>();
    if (options) {
      for (const [type, list] of Object.entries(options.resources)) {
        for (const r of list) map.set(`${type}:${r.id}`, r.label);
      }
    }
    return (type: string, id: string | null) =>
      id ? (map.get(`${type}:${id}`) ?? `${id.slice(0, 8)}…`) : "—";
  }, [options]);

  const revocation = useActionMutation(revokeGrant, {
    invalidates: GRANT_READS,
    successMessage: "Access revoked",
  });
  /** The grant a revoke is in flight for: its row menu is closed until it settles. */
  const revokingId = revocation.isPending ? revocation.variables?.id : undefined;

  const filtered = useMemo(
    () => grantsQuery.data?.rows ?? [],
    [grantsQuery.data],
  );
  // WHEN the rows were read comes from the payload, never from this renderer, so the server render
  // and the hydrating client print the same "… ago" (React #418, the members page's #5377 rule).
  const asOf = grantsQuery.data?.asOf;
  /** Every grant in this scope — what "no grants yet" means, as opposed to "none match". */
  const total = grantsQuery.data?.total ?? 0;
  const counts = useMemo(
    () => ({
      scopes: facetCounts(grantsQuery.data?.facets.scopes ?? []),
      roles: facetCounts(grantsQuery.data?.facets.roles ?? []),
      effects: facetCounts(grantsQuery.data?.facets.effects ?? []),
    }),
    [grantsQuery.data],
  );
  const activeFilters = countActiveFilters(filters, DEFAULT_ACCESS_FILTERS);

  const columns = useMemo<ColumnDef<AccessGrantRow>[]>(
    () => [
      {
        id: "principal",
        header: "Principal",
        enableSorting: false,
        cell: ({ row }) => {
          const g = row.original;
          return (
            <div className="flex items-center gap-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-muted font-mono text-ui-xs text-muted-foreground">
                {userInitials({ name: g.principalLabel })}
              </span>
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-foreground">
                  {g.principalLabel}
                </span>
                <span className="font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground">
                  {g.principalType === "team" ? "Team" : "Member"}
                </span>
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
          const g = row.original;
          return (
            <div className="flex items-center gap-2">
              {g.roleName ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium text-foreground">
                  <Shield size={12} className="text-muted-foreground" />
                  {roleDisplayName(g.roleName)}
                </span>
              ) : (
                <code className="font-mono text-xs text-foreground">
                  {g.permissionKey ?? "—"}
                </code>
              )}
              {/* A deny is the one thing on this row that changes its meaning, so it reads
                  through the SHARED status device rather than a local pill. */}
              {g.effect === "deny" && (
                <StatusBadge status="deny" tier="failed" label="Deny" />
              )}
            </div>
          );
        },
      },
      {
        id: "scope",
        header: "Scope",
        enableSorting: false,
        cell: ({ row }) => {
          const g = row.original;
          return (
            <div className="flex flex-col">
              <span className="text-foreground">
                {g.resourceType === "org"
                  ? "Organization"
                  : resourceLabel(g.resourceType, g.resourceId)}
              </span>
              <span className="font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground">
                {SCOPE_LEVEL[g.resourceType] ?? g.resourceType}
              </span>
            </div>
          );
        },
      },
      {
        id: "reach",
        header: "Effective reach",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
            {reachLabel(row.original.resourceType)}
          </span>
        ),
      },
      {
        accessorKey: "createdAt",
        header: "Granted",
        cell: ({ row }) => (
          <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
            {formatRelative(row.original.createdAt, asOf ? new Date(asOf) : undefined)}
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="text-right">
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={revokingId === row.original.id}
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label="Manage grant"
                    aria-busy={revokingId === row.original.id || undefined}
                    disabled={revokingId === row.original.id}
                  >
                    <MoreHorizontal size={16} />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => setDeleting(row.original)}
                >
                  Revoke access
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    [resourceLabel, revokingId, asOf],
  );

  return (
    <div>
      {/* inheritance note */}
      <div className="mb-[18px] flex gap-3 rounded-lg border border-border bg-surface-sunken p-4">
        <Info size={16} className="mt-0.5 shrink-0 text-text-tertiary" />
        <p className="text-ui-sm leading-relaxed text-text-secondary">
          {projectId ? (
            <>
              <b className="font-medium text-text-primary">
                Grants on this Project.
              </b>{" "}
              These bind a principal to a role or permission on this Project
              alone. Org-wide grants also apply here but are managed in
              organization settings.
            </>
          ) : (
            <>
              <b className="font-medium text-text-primary">
                Org → Project inheritance.
              </b>{" "}
              A grant on the org applies everywhere; a grant on a single Project
              is exact. Lower scopes can add access, never remove it.
            </>
          )}
        </p>
      </div>

      {!entitled ? (
        <FeatureUpsell feature="access" />
      ) : forbidden ? (
        <AccessNoAccess />
      ) : grantsQuery.isPending ? (
        <PeopleListSkeleton facets={projectId ? 2 : 3} columns={6} />
      ) : grantsQuery.isError && grantsQuery.data === undefined ? (
        <RegionError
          title="Couldn't load access grants"
          description="The grant list didn't load. No access was changed."
          onRetry={() => void grantsQuery.refetch()}
        />
      ) : (
        <div aria-busy={busy}>
          <PageToolbar
            className="mb-4"
            description="Who is granted what, and where it applies."
            count={grantsQuery.data?.resultCount ?? 0}
            actions={
              <Button size="sm" onClick={() => setCreating((v) => !v)}>
                <Plus size={13} />
                Add grant
              </Button>
            }
          />

          <FilterBar>
            <FilterSearch
              value={filters.search}
              onChange={(v) => set("search", v)}
              placeholder="Search principal or scope…"
              className="w-[240px] max-w-[380px] flex-1"
            />
            {/* Scope filter is meaningless when the list is already scoped to one project. */}
            {!projectId && (
              <FacetFilter
                label="Scope"
                icon={Layers}
                options={Object.keys(SCOPE_LEVEL).map((value) => ({
                  value,
                  label: SCOPE_LEVEL[value] ?? value,
                  hint: String(counts.scopes[value] ?? 0),
                }))}
                value={filters.scopes}
                onChange={(next) => set("scopes", next)}
                searchPlaceholder="Filter scope…"
                emptyText="No scopes."
              />
            )}
            {/* Roles are an open-ended entity list (built-ins + every custom role + direct
                permission grants), so this is a searchable MultiCombobox, not a facet popover. */}
            <MultiCombobox
              placeholder="All roles"
              icon={Shield}
              className="w-[190px]"
              options={Object.keys(counts.roles)
                .sort()
                .map((value) => ({
                  value,
                  label: grantRoleLabel(value),
                  hint: String(counts.roles[value] ?? 0),
                }))}
              value={filters.roles}
              onChange={(next) => set("roles", next)}
            />
            <FacetFilter
              label="Effect"
              icon={ShieldAlert}
              options={EFFECT_OPTIONS.map((o) => ({
                value: o.value,
                label: o.label,
                hint: String(counts.effects[o.value] ?? 0),
              }))}
              value={filters.effects}
              onChange={(next) => set("effects", next)}
              searchPlaceholder="Filter effect…"
              emptyText="No effects."
            />
            <FilterBarReset count={activeFilters} onReset={reset} />
          </FilterBar>

          {/* inline grant builder */}
          {creating && options && (
            <GrantBuilder
              options={options}
              resourceLabel={resourceLabel}
              projectId={projectId}
              onCancel={() => setCreating(false)}
              onGranted={() => setCreating(false)}
            />
          )}

          {filtered.length === 0 ? (
            <EmptyState
              className="border border-border bg-surface-sunken"
              icon={<Shield />}
              title={total === 0 ? "No grants yet" : "No matching grants"}
              description={
                total === 0
                  ? "Add a grant to bind a member or team to a role."
                  : "No grant matches these filters."
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
            /* The filter standard's `isPlaceholderData` dim: these rows are the PREVIOUS
               query's answer, kept so the table does not blank on a filter change and marked
               so they are not read as the current one. */
            <div
              className={cn(
                grantsQuery.isPlaceholderData && "opacity-60 transition-opacity",
              )}
            >
              <DataTable columns={columns} data={filtered} pageSize={15} />
            </div>
          )}
        </div>
      )}

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this grant?</AlertDialogTitle>
            <AlertDialogDescription>
              The principal loses this access immediately. Inherited access from
              other grants is unaffected. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleting) revocation.mutate({ id: deleting.id });
                setDeleting(null);
              }}
              variant="destructive"
            >
              Revoke access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The inline grant builder — principal · effect · role/permission · scope + live preview. When
 * `projectId` is set the scope is fixed to that project (the picker is hidden). */
function GrantBuilder({
  options,
  resourceLabel,
  projectId,
  onCancel,
  onGranted,
}: {
  options: GrantOptions;
  resourceLabel: (type: string, id: string | null) => string;
  projectId?: string;
  onCancel: () => void;
  onGranted: () => void;
}) {
  const [principalId, setPrincipalId] = useState("");
  const [effect, setEffect] = useState<"allow" | "deny">("allow");
  const [mode, setMode] = useState<"role" | "permission">("role");
  const [roleId, setRoleId] = useState("");
  const [permissionKey, setPermissionKey] = useState("");
  const [scopeType, setScopeType] = useState(projectId ? "project" : "org");
  const [resourceId, setResourceId] = useState(projectId ?? "");
  const grant = useActionMutation(assignGrant, {
    invalidates: GRANT_READS,
    successMessage: "Access granted",
    onSuccess: () => onGranted(),
  });

  const principalOpts = options.principals.map((p) => ({
    value: p.id,
    label: p.type === "team" ? `${p.label} · team` : p.label,
  }));
  const permissionOpts = options.permissions.map((p) => ({
    value: p.key,
    label: p.key,
  }));
  const resourceOpts = (lookup(options.resources, scopeType) ?? []).map(
    (r) => ({
      value: r.id,
      label: r.label,
    }),
  );

  const what = mode === "role" ? roleId : permissionKey;
  const valid = Boolean(
    principalId && what && (scopeType === "org" || resourceId),
  );

  const preview = useMemo(() => {
    if (!valid) return null;
    const pName =
      options.principals.find((p) => p.id === principalId)?.label ?? "—";
    const wName =
      mode === "role"
        ? (options.roles.find((r) => r.id === roleId)?.name ?? "—")
        : permissionKey;
    const sName =
      scopeType === "org"
        ? "the organization"
        : resourceLabel(scopeType, resourceId);
    return { pName, wName, sName, reach: reachLabel(scopeType) };
  }, [
    valid,
    options,
    principalId,
    mode,
    roleId,
    permissionKey,
    scopeType,
    resourceId,
    resourceLabel,
  ]);

  function submit() {
    if (!valid || grant.isPending) return;
    const principal = options.principals.find((p) => p.id === principalId);
    grant.mutate({
      principalType: principal?.type ?? "user",
      principalId,
      effect,
      roleId: mode === "role" ? roleId : null,
      permissionKey: mode === "permission" ? permissionKey : null,
      resourceType: scopeType === "org" ? "org" : scopeType,
      resourceId: scopeType === "org" ? null : resourceId,
    });
  }

  return (
    <div className="mb-4 rounded-lg border border-border bg-surface p-4 shadow-sm">
      <p className="text-ui-md font-medium text-text-primary">New grant</p>
      <p className="mb-3 text-ui-xs text-text-tertiary">
        Bind a principal to a role or permission on a scope. Inheritance is
        computed from the scope you pick.
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <div className="mb-1.5 text-ui-xs text-text-tertiary">
            Principal
          </div>
          <Combobox
            options={principalOpts}
            value={principalId}
            onChange={setPrincipalId}
            placeholder="Select a member or team…"
          />
        </div>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-ui-xs text-text-tertiary">Grant</span>
            <Toggle
              value={mode}
              onChange={setMode}
              options={[
                { value: "role", label: "Role" },
                { value: "permission", label: "Permission" },
              ]}
            />
          </div>
          {mode === "role" ? (
            <SettingsSelect
              aria-label="Role"
              value={roleId}
              onChange={setRoleId}
              options={[
                { value: "", label: "Select a role…" },
                ...options.roles.map((r) => ({
                  value: r.id,
                  label: r.builtin ? `${roleDisplayName(r.name, true)} (built-in)` : r.name,
                })),
              ]}
            />
          ) : (
            <Combobox
              options={permissionOpts}
              value={permissionKey}
              onChange={setPermissionKey}
              placeholder="Select a permission…"
            />
          )}
        </div>
        <div>
          <div className="mb-1.5 text-ui-xs text-text-tertiary">Scope</div>
          {projectId ? (
            // Fixed to this project — the list is already project-scoped.
            <div className="flex h-9 items-center rounded-md border border-border bg-surface-sunken px-3 text-ui-sm text-text-secondary">
              {resourceLabel("project", projectId)}
            </div>
          ) : (
            <>
              <SettingsSelect
                aria-label="Scope"
                value={scopeType}
                onChange={(v) => {
                  setScopeType(v);
                  setResourceId("");
                }}
                options={SCOPE_OPTIONS}
              />
              {scopeType !== "org" && (
                <div className="mt-2">
                  <Combobox
                    options={resourceOpts}
                    value={resourceId}
                    onChange={setResourceId}
                    placeholder="Select a resource…"
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <span className="text-ui-xs text-text-tertiary">Effect</span>
        <Toggle
          value={effect}
          onChange={setEffect}
          options={[
            { value: "allow", label: "Allow" },
            { value: "deny", label: "Deny" },
          ]}
        />
      </div>

      {preview && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2.5">
          <Info size={13} className="mt-0.5 shrink-0 text-text-tertiary" />
          <span className="text-ui-sm text-text-secondary">
            <b className="font-medium text-text-primary">{preview.pName}</b>{" "}
            will {effect}{" "}
            <b className="font-medium text-text-primary">{preview.wName}</b> on{" "}
            <b className="font-medium text-text-primary">{preview.sName}</b> —{" "}
            {preview.reach.toLowerCase()}.
          </span>
        </div>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!valid || grant.isPending}
          onClick={submit}
        >
          {grant.isPending ? "Adding…" : "Add grant"}
        </Button>
      </div>
    </div>
  );
}

/** A small two-option segmented toggle. */
function Toggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex gap-0.5 rounded-sm border border-border-strong bg-surface-sunken p-[2px]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-[3px] px-2 py-0.5 text-ui-xs font-medium transition-colors",
            o.value === value
              ? "bg-surface text-text-primary shadow-sm"
              : "text-text-tertiary hover:text-text-secondary",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
