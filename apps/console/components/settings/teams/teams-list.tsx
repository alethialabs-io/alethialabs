"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Teams — the org's teams on the shared DataTable, on the console filter standard
// (lib/query/README.md → "Server-side filters"): a URL-synced zustand store → debounce →
// `normalizeTeamsQuery` → the `members.teams` GET procedure, which the route prefetches (#6129), paged
// on the keyset contract (`useKeysetList` + the server-mode table's `ListFooter`, LST-8 #7490). No
// count pill: the console carries no list counts.
//
// Writes go to Better Auth's organization endpoints (createTeam/updateTeam/removeTeam, and the
// member roster in ManageTeamDialog) through `useActionMutation`, so each is pending while in flight
// and the list is invalidated when it settles; a `members` hint refreshes it when someone else
// changes a team. What the viewer may write is the route's `gate` (teams-gate.ts — the same
// access-control statements the writes check), so a control they cannot use is disabled with its
// reason rather than live and refused by a toast (R6 E-08). A team has no stored slug, so none is
// shown (R6 E-14); the design's per-team description and role-tag have no backend yet — omitted and
// tracked in dataroom/spec/features/settings-design-port.md.

import { planMeta } from "@repo/plan-catalog";
import type { CellContext, ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Plus, Users } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { TeamRow } from "@/app/server/actions/teams";
import { ConfirmAction } from "@/components/confirm/confirm-action";
import { DataTable } from "@/components/data-table";
import { RegionError } from "@repo/ui/region-error";
import { viaAuth } from "@/components/settings/members/auth-action";
import { PeopleListSkeleton } from "@/components/settings/members/people-skeleton";
import { Button } from "@repo/ui/button";
import { DisabledReason } from "@repo/ui/disabled-reason";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import { EmptyState } from "@repo/ui/empty";
import { FilterEmpty } from "@repo/ui/filter-bar";
import { ListToolbar } from "@repo/ui/list-toolbar";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import { FEATURE_UPSELLS } from "@/components/settings/upgrade/feature-catalog";
import { FeatureUpsell } from "@/components/settings/upgrade/feature-upsell";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { authClient } from "@/lib/auth/client";
import { useKeysetList } from "@/lib/query/use-keyset-list";
import { useListSearchShortcut } from "@/lib/shortcuts/use-list-search-shortcut";
import { hrefWithParamPatch, selectionFromUrl, selectionPatch } from "@/lib/query/view-url-params";
import { retryUnlessRefused } from "@/lib/rpc/refusal";
import { orpc } from "@/lib/rpc/client";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useTeamsFilters } from "@/lib/stores/use-settings-filters";
import { cn } from "@repo/ui/utils";
import {
	DEFAULT_TEAMS_FILTERS,
	normalizeTeamsQuery,
	TEAM_SIZE_OPTIONS,
} from "./teams-filters";
import { ManageTeamDialog } from "./manage-team-dialog";
import { CreateTeamDialog } from "./create-team-dialog";
import { RenameTeamDialog } from "./rename-team-dialog";
import { NO_TEAM_WRITES, type TeamsGate } from "./teams-gate";

/** Two-letter avatar initials for a team name. */
function monogram(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (!parts.length) return "TM";
	return (
		(parts[0][0] ?? "") + (parts[1]?.[0] ?? parts[0][1] ?? "")
	).toUpperCase();
}

/** Why Create team is disabled without the entitlement — the plan the upsell below names. */
const TEAMS_GATE_REASON = `Teams are available on the ${planMeta(FEATURE_UPSELLS.teams.requiredPlan).name} plan.`;

/**
 * Why a team write is disabled for a viewer whose role does not hold it. Deliberately not the shared
 * "ask an owner or admin" sentence: which roles may manage teams is an open decision (#7050), and
 * today no role holds the team statements, so that sentence would send an owner to ask themselves.
 */
export const TEAM_WRITE_DENIED = "Your role in this organization doesn't include managing teams.";

/** The reason a team write is unavailable, or null when the viewer may make it. */
function writeReason(entitled: boolean, allowed: boolean): string | null {
	if (!entitled) return TEAMS_GATE_REASON;
	return allowed ? null : TEAM_WRITE_DENIED;
}

/** Every read that shows a team: the teams page, and the member lists' team chips. */
const TEAM_READS = [orpc.members.key()];

// ── STABLE CELLS (R6 E-15, the members table's #5023) ────────────────────────────────────────
//
// Every cell is a MODULE-LEVEL component and the columns are a module-level constant. `DataTable`
// renders a cell through `flexRender`, for which the `cell` function IS the component type, so
// columns rebuilt on every render gave every cell a new type each time: React remounted every cell
// on any re-render — a refetch, a keystroke in the search box — and closed a row menu under the
// person using it. What changes between renders (the gate, which row is mid-delete, the openers)
// reaches the cells through `TeamsCellsContext`; a context change RE-RENDERS a cell, only a new
// type REMOUNTS it.

/** The per-render state the cells read. */
interface TeamsCells {
	entitled: boolean;
	gate: TeamsGate;
	/** The team a delete is in flight for: its row menu is closed until it settles. */
	removingId: string | undefined;
	openRoster: (team: TeamRow) => void;
	openRename: (team: TeamRow) => void;
	askDelete: (team: TeamRow) => void;
}

const TeamsCellsContext = createContext<TeamsCells | null>(null);

/** The teams table's cell state; a cell rendered outside `TeamsList` is a wiring defect. */
function useTeamsCells(): TeamsCells {
	const ctx = useContext(TeamsCellsContext);
	if (!ctx) throw new Error("A teams-table cell rendered outside TeamsCellsContext.");
	return ctx;
}

/** Monogram and name. */
function TeamCell({ row }: CellContext<TeamRow, unknown>) {
	const t = row.original;
	return (
		<div className="flex min-w-0 items-center gap-3">
			<span
				aria-hidden
				className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-ink font-display text-ui-sm font-semibold text-ink-foreground"
			>
				{monogram(t.name)}
			</span>
			<span className="truncate text-ui-md font-medium text-text-primary">{t.name}</span>
		</div>
	);
}

/** The avatar stack and the member count. */
function MembersCell({ row }: CellContext<TeamRow, unknown>) {
	const t = row.original;
	return (
		<div className="flex items-center gap-3">
			{t.members.length > 0 && (
				<div aria-hidden className="flex -space-x-2">
					{t.members.slice(0, 4).map((m) => (
						<span
							key={m.userId}
							className="flex size-6 items-center justify-center rounded-full border-2 border-surface bg-surface-muted font-mono text-ui-3xs text-text-secondary"
						>
							{m.initials}
						</span>
					))}
					{t.members.length > 4 && (
						<span className="flex size-6 items-center justify-center rounded-full border-2 border-surface bg-surface-sunken font-mono text-ui-3xs text-text-tertiary">
							+{t.members.length - 4}
						</span>
					)}
				</div>
			)}
			<span className="whitespace-nowrap font-mono text-ui-xs text-text-tertiary">
				{t.memberCount} member{t.memberCount === 1 ? "" : "s"}
			</span>
		</div>
	);
}

/**
 * One row's "Manage team …" menu. The roster is always viewable; rename and delete are items that
 * say why when the viewer may not use them (`disabledReason`), never items that are missing.
 */
function ActionsCell({ row }: CellContext<TeamRow, unknown>) {
	const { entitled, gate, removingId, openRoster, openRename, askDelete } = useTeamsCells();
	const t = row.original;
	const removing = removingId === t.id;
	return (
		<div className="text-right">
			<DropdownMenu>
				<DropdownMenuTrigger
					disabled={removing}
					render={
						<Button
							variant="ghost"
							size="icon"
							className="size-7"
							aria-label={`Manage team ${t.name}`}
							aria-busy={removing || undefined}
							disabled={removing}
						>
							<MoreHorizontal size={16} />
						</Button>
					}
				/>
				<DropdownMenuContent align="end" className="w-56">
					<DropdownMenuItem onClick={() => openRoster(t)}>Manage members</DropdownMenuItem>
					<DropdownMenuItem
						disabledReason={writeReason(entitled, gate.canRename)}
						onClick={() => openRename(t)}
					>
						Rename team
					</DropdownMenuItem>
					{/* DELETE IS GATED ON THE PLAN ONLY, FOR NOW — the one team write that is not on the
					    role gate, and deliberately. Today no role holds `team:delete` (#7050 is undecided),
					    so the role gate would disable it for everyone; but `teams.delete` is a `confirmed`
					    entry in `destructive-actions.yaml`, and the release gate's destructive spec opens
					    its confirmation on every run — a disabled item there is a timed-out verdict, and
					    that registry and spec belong to other units (#6830, #6819). So the confirmation
					    stays reachable and the server's refusal is shown in it. When #7050 names the roles,
					    move this onto `gate.canDelete` in the same PR that updates the registry entry. */}
					<DropdownMenuItem
						className="text-destructive focus:text-destructive"
						disabledReason={entitled ? null : TEAMS_GATE_REASON}
						onClick={() => askDelete(t)}
					>
						Delete team
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

/** The table's columns: module-level, so no render can hand `DataTable` a new cell type. */
const TEAM_COLUMNS: ColumnDef<TeamRow>[] = [
	{ accessorKey: "name", header: "Team", cell: TeamCell },
	{ accessorKey: "memberCount", header: "Members", cell: MembersCell },
	{ id: "actions", header: "", enableSorting: false, cell: ActionsCell },
];

/**
 * Settings · Teams. `entitled` is the `teams` entitlement as the ROUTE resolved it on the server,
 * so the first paint already knows whether Create team is live (F017); the workspace store can
 * still turn it on later (an in-session upgrade), never off.
 */
export function TeamsList({
	entitled: serverEntitled = false,
	gate = NO_TEAM_WRITES,
}: {
	entitled?: boolean;
	/** What the viewer may write, as the route decided it on the server (teams-gate.ts). */
	gate?: TeamsGate;
} = {}) {
	// Teams are an Enterprise capability. Without it the page stays visible — existing teams render
	// read-only, Create team is disabled with its reason, and the upsell is the body when there is
	// nothing else to show — matching the server-side `beforeCreateTeam` gate (no hard wall).
	const storeEntitled = useEntitlement("teams");
	const entitled = serverEntitled || storeEntitled === true;

	// Filter state: the store is the source of truth, the URL mirrors it (shareable views),
	// and the free text is debounced before it can reach a query key.
	const filters = useTeamsFilters((s) => s.filters);
	const set = useTeamsFilters((s) => s.set);
	const reset = useTeamsFilters((s) => s.reset);
	const urlRead = useFilterUrlSync(useTeamsFilters, DEFAULT_TEAMS_FILTERS);
	// Seeded from the URL once it is read, so a pasted `?search=…` asks first for the key the
	// link names rather than spending one debounce on the pristine one (#4999, members).
	const search = useDebouncedValue(filters.search, 250, { urlRead });
	const query = useMemo(
		() => normalizeTeamsQuery(filters, search),
		[filters, search],
	);

	const [creating, setCreating] = useState(false);
	// `/` focuses the search while this page is mounted (polish-wave spec §3); called before the
	// early returns below, as every hook must be.
	const { inputRef, shortcut } = useListSearchShortcut();
	const [renaming, setRenaming] = useState<TeamRow | null>(null);
	const [deleting, setDeleting] = useState<TeamRow | null>(null);
	// The name the delete confirmation is RENDERING, which outlives `deleting` by one close (the
	// dialog stays mounted and fades out; a description built from the cleared row would blank).
	const [deletingName, setDeletingName] = useState("");
	const createReason = writeReason(entitled, gate.canCreate);

	// Filtered AND paged SERVER-SIDE: `members.teams` narrows in SQL a page at a time,
	// alphabetically, and its first page carries the size facet counted over the org's UNFILTERED teams, so
	// an option never disappears as you select it. The normalized query IS the key, and
	// `keepPreviousData` (in the hook) keeps the table's rows across a filter change —
	// `isPlaceholderData` is what marks them stale while the next answer loads.
	const list = useKeysetList(orpc.members.teams, query);
	const rows = list.rows;
	const facets = list.facets;
	const counts = useMemo(() => {
		const byBucket: Record<string, number> = {};
		for (const o of facets?.sizes ?? []) byBucket[o.value] = o.count;
		return byBucket;
	}, [facets]);

	// The roster dialog's team is URL state (`?selected=<team id>`, R6 E-23): a link to a team opens
	// its roster, and a refresh keeps it. Written with `history.replaceState`, so opening a roster is
	// not a server navigation.
	const searchParams = useSearchParams();
	const selectedId = selectionFromUrl(searchParams);
	const openRoster = useCallback((team: TeamRow | null) => {
		window.history.replaceState(
			null,
			"",
			hrefWithParamPatch(window.location.pathname, window.location.search, selectionPatch(team?.id ?? null)),
		);
	}, []);
	// A linked team the loaded pages do not hold is read BY ID through the same builder and scope as
	// the list (`members.teams` with `id`), so a link to a team on page three opens at once.
	const selectedLoaded = selectedId !== null && rows.some((r) => r.id === selectedId);
	const selectedRead = useQuery({
		...orpc.members.teams.queryOptions({ input: { id: selectedId ?? undefined } }),
		enabled: selectedId !== null && !selectedLoaded && !list.isPending,
		retry: retryUnlessRefused,
	});
	const selectedTeam = selectedRead.data?.rows[0];
	// The list is BUSY while what it shows may not answer the URL and the bar: before the link has
	// been read into the store, before the first answer, while the rows are the previous query's
	// placeholder, and while a typed search is still inside its debounce — the jobs, runners,
	// members, alerts and activity lists' rule (#4980, #5045, #5471).
	const busy =
		!urlRead ||
		list.isPending ||
		list.isPlaceholderData ||
		filters.search !== search;

	const removeTeam = useActionMutation(
		({ teamId }: { teamId: string }) =>
			viaAuth(() => authClient.organization.removeTeam({ teamId })),
		{
			invalidates: TEAM_READS,
			successMessage: "Team deleted",
		},
	);
	/** The team a delete is in flight for: its row menu is closed until it settles. */
	const removingId = removeTeam.isPending ? removeTeam.variables?.teamId : undefined;

	const askDelete = useCallback((team: TeamRow) => {
		setDeletingName(team.name);
		setDeleting(team);
	}, []);
	const cells = useMemo<TeamsCells>(
		() => ({
			entitled,
			gate,
			removingId,
			openRoster,
			openRename: setRenaming,
			askDelete,
		}),
		[entitled, gate, removingId, openRoster, askDelete],
	);

	// The team the roster dialog is open on, read from the CURRENT rows when they hold it, so an add
	// or a removal shows in the dialog as soon as the list refetches — otherwise from the by-id read
	// above (a deep link to a team on a page not loaded yet, or one the filters now exclude).
	const manageRow = selectedId ? (rows.find((r) => r.id === selectedId) ?? selectedTeam ?? null) : null;

	const activeFilters = countActiveFilters(filters, DEFAULT_TEAMS_FILTERS);

	// Pending is the route skeleton's shape (B2); the route prefetches, so this is reached only when
	// the cache was evicted under the page.
	if (list.isPending) return <PeopleListSkeleton facets={1} columns={3} />;
	// A failed first load is an ERROR, never "No teams yet" and never the upsell (B4). A failed
	// refresh behind rows is the table's stale notice; a failed later page, the footer's retry line.
	if (list.query.isError && list.query.data === undefined) {
		return (
			<RegionError
				title="Couldn't load teams"
				description="The team list didn't load. Nothing about your teams changed."
				onRetry={() => void list.query.refetch()}
			/>
		);
	}
	/** The org has no team at all — the first-run state, a boolean from the server, never a count. */
	const firstRun = list.universeEmpty === true;

	// Without the entitlement, or without a role that may create a team, the SAME button is shown
	// disabled with its reason (F017, R6 E-08) — not an enabled control that opens an upgrade modal
	// or ends in a refusal toast. The upsell panel below explains the plan.
	const createAction = (
		<DisabledReason reason={createReason}>
			<Button size="sm" onClick={() => setCreating(true)}>
				<Plus size={13} />
				Create team
			</Button>
		</DisabledReason>
	);
	// The upsell IS the page body when the org is not entitled and has no teams to show; then there
	// is nothing to filter, so the filter bar is not drawn above it (F017).
	const upsellIsBody = !entitled && firstRun;

	return (
		<div aria-busy={busy}>
			{/* With the upsell as the body there is nothing to filter, so the row carries only the
			    disabled Create team (F017). */}
			<ListToolbar
				search={
					upsellIsBody
						? undefined
						: {
								value: filters.search,
								onChange: (v) => set("search", v),
								placeholder: "Search teams…",
								inputRef,
								shortcut,
							}
				}
				facets={
					upsellIsBody
						? undefined
						: [
								{
									label: "Size",
									icon: Users,
									options: TEAM_SIZE_OPTIONS.map((o) => ({
										value: o.value,
										label: o.label,
										hint: String(counts[o.value] ?? 0),
									})),
									value: filters.sizes,
									onChange: (next: string[]) => set("sizes", next),
									searchPlaceholder: "Filter size…",
									emptyText: "No sizes.",
								},
							]
				}
				reset={upsellIsBody ? undefined : { count: activeFilters, onReset: reset }}
				actions={createAction}
			/>

			{/* table */}
			{rows.length === 0 ? (
				upsellIsBody ? (
					<FeatureUpsell feature="teams" />
				) : list.universeEmpty === false ? (
					<FilterEmpty noun="teams" onClear={reset} />
				) : (
					<EmptyState
						className="border border-border bg-surface-sunken"
						icon={<Users />}
						title="No teams yet"
						description="Create one to grant access to a group of members at once."
						action={
							createReason === null ? (
								<Button variant="outline" size="sm" onClick={() => setCreating(true)}>
									<Plus size={13} />
									Create team
								</Button>
							) : undefined
						}
					/>
				)
			) : (
				<div
					className={cn(
						list.isPlaceholderData && "opacity-60 transition-opacity",
					)}
				>
					<TeamsCellsContext.Provider value={cells}>
						<DataTable columns={TEAM_COLUMNS} keyset={list} />
					</TeamsCellsContext.Provider>
				</div>
			)}

			{manageRow && (
				<ManageTeamDialog
					team={manageRow}
					open
					onOpenChange={(o) => !o && openRoster(null)}
					rosterReason={writeReason(entitled, gate.canEditRoster)}
				/>
			)}

			<RenameTeamDialog team={renaming} onOpenChange={(o) => !o && setRenaming(null)} />

			{createReason === null && <CreateTeamDialog open={creating} onOpenChange={setCreating} />}

			{/* The console's one confirmation (CON-SM2): it stays open while the delete runs, closes
			    itself once it has succeeded, and stays up beside the reason when it is refused. */}
			<ConfirmAction
				open={deleting !== null}
				onOpenChange={(o) => {
					if (!o) setDeleting(null);
				}}
				title={`Delete team \u201C${deletingName}\u201D?`}
				description={`The team and its membership are removed. Grants made to the team are revoked; its members keep their own roles. This cannot be undone.`}
				confirmLabel="Delete team"
				pendingLabel="Deleting…"
				severity={{ level: "confirm" }}
				mutation={removeTeam}
				variables={deleting ? { teamId: deleting.id } : null}
			/>
		</div>
	);
}
