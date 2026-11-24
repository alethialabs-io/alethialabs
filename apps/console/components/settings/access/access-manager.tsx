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

import { zodResolver } from "@hookform/resolvers/zod";
import type { ColumnDef } from "@tanstack/react-table";
import { Info, Layers, MoreHorizontal, Plus, Shield, ShieldAlert } from "lucide-react";
import { useCallback, useId, useMemo, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import {
  type AccessGrantRow,
  assignGrant,
  type GrantOptions,
  revokeGrant,
} from "@/app/server/actions/grants";
import { ConfirmAction } from "@/components/confirm/confirm-action";
import { RegionError } from "@/components/errors/region-error";
import { manageReason } from "@/components/errors/manage-gate";
import { FormRootError } from "@/components/forms/form-root-error";
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@repo/ui/sheet";
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
import { formatRelative } from "@repo/format";
import { MultiCombobox } from "@repo/ui/multi-combobox";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { StatusBadge } from "@repo/ui/status-badge";
import { Skeleton } from "@repo/ui/skeleton";
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
import { SETTINGS_LIST_PAGE_SIZE } from "@/components/settings/members/members-filters";

/** Every read a grant write shows in: the grants list, the role catalog's grant counts. */
const GRANT_READS = [orpc.members.key()];

/** What a grant's scope reads as when its resource is not in the option lists (R6 F-19). */
const UNKNOWN_RESOURCE_LABEL = "Unknown resource";

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
  canManage,
}: {
  projectId?: string;
  customRoles?: boolean;
  /** The route's prefetch was refused (`member:view`): the no-access render from the first paint. */
  forbidden?: boolean;
  /**
   * Whether this viewer may add and revoke grants, decided by the ROUTE with the question the writes
   * ask (`member:manage_members`, R6 E-08). `false` disables Add grant and Revoke WITH the reason.
   * Left out, the route has not decided it, and the controls stay live for the write itself to
   * rule on — the project route (CON-L11's scope) does not pass it yet.
   */
  canManage?: boolean;
} = {}) {
  /** Why the viewer cannot add or revoke a grant, or null when they can (or the route did not say). */
  const writeReason = canManage === undefined ? null : manageReason({ canManage });
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
  // What the revoke confirmation is RENDERING, which outlives `deleting` by one close.
  const [revokingCopy, setRevokingCopy] = useState({ what: "this grant", who: "this member" });
  /** Opens the revoke confirmation for `g`, naming the grant and who holds it. */
  const askRevoke = useCallback((g: AccessGrantRow) => {
    setRevokingCopy({
      what: g.roleName ? roleDisplayName(g.roleName) : (g.permissionKey ?? "this grant"),
      who: g.principalLabel,
    });
    setDeleting(g);
  }, []);

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
    // A scoped id the option lists do not name (deleted, or not visible to this viewer) reads as
    // "Unknown resource" — never a UUID fragment nobody can act on (R6 F-19).
    return (type: string, id: string | null) =>
      id ? (map.get(`${type}:${id}`) ?? UNKNOWN_RESOURCE_LABEL) : "—";
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
        // "Member or team", the builder's own label for the same field (R6 E-25): "Principal" was
        // the only place in Settings that named a member that way.
        header: "Member or team",
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
                    aria-label={`Manage grant for ${row.original.principalLabel}`}
                    aria-busy={revokingId === row.original.id || undefined}
                    disabled={revokingId === row.original.id}
                  >
                    <MoreHorizontal size={16} />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  disabledReason={writeReason}
                  onClick={() => askRevoke(row.original)}
                >
                  Revoke access
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ],
    [resourceLabel, revokingId, asOf, writeReason, askRevoke],
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
              These bind a member or team to a role or permission on this Project
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
              <DisabledReason reason={writeReason}>
                <Button size="sm" onClick={() => setCreating(true)}>
                  <Plus size={13} />
                  Add grant
                </Button>
              </DisabledReason>
            }
          />

          <FilterBar>
            <FilterSearch
              value={filters.search}
              onChange={(v) => set("search", v)}
              placeholder="Search member, team or scope…"
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

          {/* The grant builder is a long form (who · effect · role or permission · scope, and a
              live preview), so it opens in a sheet — Settings' shape for a long create, beside the
              dialog for a short one (R6 E-20); it used to be an inline panel above the table. Before
              the options have loaded the sheet holds their skeleton, and a failed options read is an
              error with a retry inside it — never an "Add grant" that silently does nothing (R6 E-16). */}
          <Sheet open={creating} onOpenChange={setCreating}>
            <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-xl">
              <SheetHeader className="gap-1 border-b border-border/60 p-5">
                <SheetTitle className="font-display text-base">New grant</SheetTitle>
                <SheetDescription className="text-xs">
                  Bind a member or team to a role or permission on a scope. Inheritance is computed
                  from the scope you pick.
                </SheetDescription>
              </SheetHeader>
              <div className="p-5">
                {options ? (
                  <GrantBuilder
                    options={options}
                    resourceLabel={resourceLabel}
                    projectId={projectId}
                    onCancel={() => setCreating(false)}
                    onGranted={() => setCreating(false)}
                  />
                ) : optionsQuery.isError ? (
                  <RegionError
                    title="Couldn't load what can be granted"
                    description="The members, roles and resources a grant can name didn't load, so a grant can't be built yet. No access was changed."
                    onRetry={() => void optionsQuery.refetch()}
                  />
                ) : (
                  <GrantBuilderSkeleton />
                )}
              </div>
            </SheetContent>
          </Sheet>

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
                total > 0 ? (
                  <Button variant="outline" size="sm" onClick={reset}>
                    Clear filters
                  </Button>
                ) : writeReason === null ? (
                  <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
                    <Plus size={13} />
                    Add grant
                  </Button>
                ) : undefined
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
              <DataTable columns={columns} data={filtered} pageSize={SETTINGS_LIST_PAGE_SIZE} />
            </div>
          )}
        </div>
      )}

      {/* The console's one confirmation (R6 E-21): it names whose access goes and stays open
          while the revoke runs. */}
      <ConfirmAction
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
        title={`Revoke ${revokingCopy.what} from ${revokingCopy.who}?`}
        description={`${revokingCopy.who} loses this access immediately. Access from other grants is unaffected. This cannot be undone.`}
        confirmLabel="Revoke access"
        pendingLabel="Revoking…"
        severity={{ level: "confirm" }}
        mutation={revocation}
        variables={deleting ? { id: deleting.id } : null}
      />
    </div>
  );
}

/** The grant builder's form: what is granted, to whom, where. */
const grantFormSchema = z
  .object({
    principalId: z.string(),
    effect: z.enum(["allow", "deny"]),
    mode: z.enum(["role", "permission"]),
    roleId: z.string(),
    permissionKey: z.string(),
    scopeType: z.string(),
    resourceId: z.string(),
  })
  // Every "pick one" rule is a refinement, not a field constraint: a refinement runs only once the
  // object's own shape parses, so a field-level `min(1)` failing first would hide the others and
  // the form would reveal its missing choices one press at a time.
  .superRefine((v, ctx) => {
    if (v.principalId === "") {
      ctx.addIssue({ code: "custom", path: ["principalId"], message: "Pick a member or team." });
    }
    if (v.mode === "role" && v.roleId === "") {
      ctx.addIssue({ code: "custom", path: ["roleId"], message: "Pick a role." });
    }
    if (v.mode === "permission" && v.permissionKey === "") {
      ctx.addIssue({ code: "custom", path: ["permissionKey"], message: "Pick a permission." });
    }
    if (v.scopeType !== "org" && v.resourceId === "") {
      ctx.addIssue({ code: "custom", path: ["resourceId"], message: "Pick what this grant applies to." });
    }
  });
type GrantForm = z.infer<typeof grantFormSchema>;

/** The builder fields a server field error may name. */
const GRANT_FIELDS = ["principalId", "roleId", "permissionKey", "resourceId"] as const;

/** A field's inline error, referenced by its control's `aria-describedby`. */
function GrantFieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1.5 text-ui-xs text-destructive">
      {message}
    </p>
  );
}

/**
 * The inline grant builder — principal · effect · role/permission · scope + live preview. When
 * `projectId` is set the scope is fixed to that project (the picker is hidden).
 *
 * A react-hook-form form over a zod schema (R6 E-16): every field has a visible label its control is
 * named by, a missing choice is said under that field when Add grant is pressed (rather than a button
 * that stays disabled without saying why), and the write goes through the mutation contract —
 * pending (no second grant while one is in flight), field refusals under their field, any other
 * refusal (a grant above your own access, a principal who is not an active member) in the form.
 */
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
  const ids = {
    principal: useId(),
    principalError: useId(),
    grant: useId(),
    whatError: useId(),
    scope: useId(),
    resourceError: useId(),
    effect: useId(),
  };
  const form = useForm<GrantForm>({
    resolver: zodResolver(grantFormSchema),
    defaultValues: {
      principalId: "",
      effect: "allow",
      mode: "role",
      roleId: "",
      permissionKey: "",
      scopeType: projectId ? "project" : "org",
      resourceId: projectId ?? "",
    },
  });
  const { errors } = form.formState;
  const values = useWatch({ control: form.control });

  const grant = useActionMutation(assignGrant, {
    invalidates: GRANT_READS,
    successMessage: "Access granted",
    form: { instance: form, fields: GRANT_FIELDS },
    onRefusal: (error) =>
      form.setError("root.server", { type: "server", message: error.message }),
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
  const scopeType = values.scopeType ?? "org";
  const mode = values.mode ?? "role";
  const effect = values.effect ?? "allow";
  const resourceOpts = (lookup(options.resources, scopeType) ?? []).map((r) => ({
    value: r.id,
    label: r.label,
  }));

  // The preview reads the CURRENT choices and appears once they name a complete grant.
  const preview = useMemo(() => {
    const parsed = grantFormSchema.safeParse(values);
    if (!parsed.success) return null;
    const v = parsed.data;
    const pName = options.principals.find((p) => p.id === v.principalId)?.label ?? "—";
    const wName =
      v.mode === "role"
        ? (options.roles.find((r) => r.id === v.roleId)?.name ?? "—")
        : v.permissionKey;
    const sName =
      v.scopeType === "org" ? "the organization" : resourceLabel(v.scopeType, v.resourceId);
    return { pName, wName, sName, reach: reachLabel(v.scopeType) };
  }, [values, options, resourceLabel]);

  const submit = form.handleSubmit((v) => {
    const principal = options.principals.find((p) => p.id === v.principalId);
    grant.submit({
      principalType: principal?.type ?? "user",
      principalId: v.principalId,
      effect: v.effect,
      roleId: v.mode === "role" ? v.roleId : null,
      permissionKey: v.mode === "permission" ? v.permissionKey : null,
      resourceType: v.scopeType === "org" ? "org" : v.scopeType,
      resourceId: v.scopeType === "org" ? null : v.resourceId,
    });
  });

  const whatError = mode === "role" ? errors.roleId?.message : errors.permissionKey?.message;

  return (
    <form
      noValidate
      aria-label="New grant"
      onSubmit={(e) => void submit(e)}
    >

      <fieldset disabled={grant.isPending} className="m-0 min-w-0 border-0 p-0">
        <div className="grid gap-3">
          <div>
            <div id={ids.principal} className="mb-1.5 text-ui-xs text-text-tertiary">
              Member or team
            </div>
            <Controller
              control={form.control}
              name="principalId"
              render={({ field }) => (
                <Combobox
                  options={principalOpts}
                  value={field.value}
                  onChange={field.onChange}
                  placeholder="Select a member or team…"
                  labelledBy={ids.principal}
                  describedBy={errors.principalId ? ids.principalError : undefined}
                  invalid={Boolean(errors.principalId)}
                />
              )}
            />
            <GrantFieldError id={ids.principalError} message={errors.principalId?.message} />
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span id={ids.grant} className="text-ui-xs text-text-tertiary">
                Grant
              </span>
              <Controller
                control={form.control}
                name="mode"
                render={({ field }) => (
                  <Toggle
                    label="Grant a role or a single permission"
                    value={field.value}
                    onChange={field.onChange}
                    options={[
                      { value: "role", label: "Role" },
                      { value: "permission", label: "Permission" },
                    ]}
                  />
                )}
              />
            </div>
            {mode === "role" ? (
              <Controller
                control={form.control}
                name="roleId"
                render={({ field }) => (
                  <SettingsSelect
                    aria-label="Role"
                    value={field.value}
                    onChange={field.onChange}
                    options={[
                      { value: "", label: "Select a role…" },
                      ...options.roles.map((r) => ({
                        value: r.id,
                        label: r.builtin ? `${roleDisplayName(r.name, true)} (built-in)` : r.name,
                      })),
                    ]}
                  />
                )}
              />
            ) : (
              <Controller
                control={form.control}
                name="permissionKey"
                render={({ field }) => (
                  <Combobox
                    options={permissionOpts}
                    value={field.value}
                    onChange={field.onChange}
                    placeholder="Select a permission…"
                    labelledBy={ids.grant}
                    describedBy={errors.permissionKey ? ids.whatError : undefined}
                    invalid={Boolean(errors.permissionKey)}
                  />
                )}
              />
            )}
            <GrantFieldError id={ids.whatError} message={whatError} />
          </div>
          <div>
            <div id={ids.scope} className="mb-1.5 text-ui-xs text-text-tertiary">
              Scope
            </div>
            {projectId ? (
              // Fixed to this project — the list is already project-scoped.
              <div
                aria-labelledby={ids.scope}
                className="flex h-9 items-center rounded-md border border-border bg-surface-sunken px-3 text-ui-sm text-text-secondary"
              >
                {resourceLabel("project", projectId)}
              </div>
            ) : (
              <>
                <Controller
                  control={form.control}
                  name="scopeType"
                  render={({ field }) => (
                    <SettingsSelect
                      aria-label="Scope"
                      value={field.value}
                      onChange={(v) => {
                        field.onChange(v);
                        form.setValue("resourceId", "");
                        form.clearErrors("resourceId");
                      }}
                      options={SCOPE_OPTIONS}
                    />
                  )}
                />
                {scopeType !== "org" && (
                  <div className="mt-2">
                    <Controller
                      control={form.control}
                      name="resourceId"
                      render={({ field }) => (
                        <Combobox
                          options={resourceOpts}
                          value={field.value}
                          onChange={field.onChange}
                          placeholder="Select a resource…"
                          labelledBy={ids.scope}
                          describedBy={errors.resourceId ? ids.resourceError : undefined}
                          invalid={Boolean(errors.resourceId)}
                        />
                      )}
                    />
                  </div>
                )}
                <GrantFieldError id={ids.resourceError} message={errors.resourceId?.message} />
              </>
            )}
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <span id={ids.effect} className="text-ui-xs text-text-tertiary">
            Effect
          </span>
          <Controller
            control={form.control}
            name="effect"
            render={({ field }) => (
              <Toggle
                label="Effect"
                value={field.value}
                onChange={field.onChange}
                options={[
                  { value: "allow", label: "Allow" },
                  { value: "deny", label: "Deny" },
                ]}
              />
            )}
          />
        </div>
      </fieldset>

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

      <FormRootError form={form} className="mt-3" />

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={grant.isPending} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={grant.isPending} aria-busy={grant.isPending}>
          {grant.isPending ? "Adding…" : "Add grant"}
        </Button>
      </div>
    </form>
  );
}

/** The grant builder before its options have loaded: its box, three fields and its buttons. */
function GrantBuilderSkeleton() {
  return (
    <div aria-busy>
      <div aria-hidden>
        <Skeleton className="mb-2 h-4 w-24" />
        <Skeleton className="mb-3 h-3 w-2/3" />
        <div className="grid gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i}>
              <Skeleton className="mb-1.5 h-3 w-16" />
              <Skeleton className="h-9 w-full rounded-md" />
            </div>
          ))}
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Skeleton className="h-8 w-16 rounded-md" />
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
      </div>
    </div>
  );
}

/** A small two-option segmented toggle; each option reports whether it is the chosen one. */
function Toggle<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  /** What the choice is, for assistive tech: the group's name. */
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex gap-0.5 rounded-sm border border-border-strong bg-surface-sunken p-[2px]"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-[3px] px-2 py-0.5 text-ui-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
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
