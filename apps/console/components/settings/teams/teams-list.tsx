"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Teams — the org's teams on the shared DataTable, on the console filter standard
// (lib/query/README.md → "Server-side filters"): a URL-synced zustand store → debounce →
// `normalizeTeamsQuery` → the `members.teams` GET procedure, which the route prefetches (#6129).
//
// Writes go to Better Auth's organization endpoints (createTeam/removeTeam, and the member roster
// in ManageTeamDialog) through `useActionMutation`, so each is pending while in flight and the list
// is invalidated when it settles; a `members` hint refreshes it when someone else changes a team.
// The design's per-team description, stored slug and role-tag have no backend yet — omitted and
// tracked in dataroom/spec/features/settings-design-port.md.

import { zodResolver } from "@hookform/resolvers/zod";
import { planMeta } from "@repo/plan-catalog";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Plus, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import type { TeamRow } from "@/app/server/actions/teams";
import { DataTable } from "@/components/data-table";
import { RegionError } from "@/components/errors/region-error";
import { viaAuth } from "@/components/settings/members/auth-action";
import { PeopleListSkeleton } from "@/components/settings/members/people-skeleton";
import { settingsControl, settingsControlSize } from "@/components/settings/settings-ui";
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
import { PageToolbar } from "@repo/ui/page-toolbar";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import { FEATURE_UPSELLS } from "@/components/settings/upgrade/feature-catalog";
import { FeatureUpsell } from "@/components/settings/upgrade/feature-upsell";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { authClient } from "@/lib/auth/client";
import { useTeamsPageQuery } from "@/lib/query/use-teams-query";
import { orpc } from "@/lib/rpc/client";
import { slugifyOrEmpty } from "@/lib/utils/slugify";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useTeamsFilters } from "@/lib/stores/use-settings-filters";
import { cn } from "@repo/ui/utils";
import {
	DEFAULT_TEAMS_FILTERS,
	normalizeTeamsQuery,
	TEAM_SIZE_OPTIONS,
} from "./teams-filters";
import { ManageTeamDialog } from "./manage-team-dialog";

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

/** Every read that shows a team: the teams page, and the member lists' team chips. */
const TEAM_READS = [orpc.members.key()];

/** The inline create form: a team name. */
const newTeamSchema = z.object({ name: z.string().trim().min(1, "Name the team").max(120) });
type NewTeam = z.infer<typeof newTeamSchema>;

/**
 * Settings · Teams. `entitled` is the `teams` entitlement as the ROUTE resolved it on the server,
 * so the first paint already knows whether Create team is live (F017); the workspace store can
 * still turn it on later (an in-session upgrade), never off.
 */
export function TeamsList({ entitled: serverEntitled = false }: { entitled?: boolean } = {}) {
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
	const [manage, setManage] = useState<TeamRow | null>(null);
	const [deleting, setDeleting] = useState<TeamRow | null>(null);
	const form = useForm<NewTeam>({
		resolver: zodResolver(newTeamSchema),
		defaultValues: { name: "" },
	});

	// Filtered SERVER-SIDE: `members.teams` narrows in SQL and returns the size facet counted
	// over the org's UNFILTERED teams, so an option never disappears as you select it. The
	// normalized query IS the input, and `keepPreviousData` (in the hook) keeps the table's rows
	// across a filter change — `isPlaceholderData` is what marks them stale while the next
	// answer loads.
	const teamsQuery = useTeamsPageQuery(query);
	const rows = useMemo(() => teamsQuery.data?.rows ?? [], [teamsQuery.data]);
	const total = teamsQuery.data?.total ?? 0;
	const counts = useMemo(() => {
		const byBucket: Record<string, number> = {};
		for (const o of teamsQuery.data?.facets.sizes ?? []) byBucket[o.value] = o.count;
		return byBucket;
	}, [teamsQuery.data]);
	// The list is BUSY while what it shows may not answer the URL and the bar: before the link has
	// been read into the store, before the first answer, while the rows are the previous query's
	// placeholder, and while a typed search is still inside its debounce — the jobs, runners,
	// members, alerts and activity lists' rule (#4980, #5045, #5471).
	const busy =
		!urlRead ||
		teamsQuery.isPending ||
		teamsQuery.isPlaceholderData ||
		filters.search !== search;

	const createTeam = useActionMutation(
		({ name }: NewTeam) => viaAuth(() => authClient.organization.createTeam({ name })),
		{
			invalidates: TEAM_READS,
			successMessage: "Team created",
			onSuccess: () => {
				form.reset({ name: "" });
				setCreating(false);
			},
		},
	);
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

	const submitCreate = form.handleSubmit((values) => {
		if (!entitled || createTeam.isPending) return;
		createTeam.mutate(values);
	});

	// The team the roster dialog is open on, read from the CURRENT rows, so an add or a removal
	// shows in the dialog as soon as the list refetches; the snapshot covers a team the filters
	// now exclude.
	const manageRow = manage ? (rows.find((r) => r.id === manage.id) ?? manage) : null;

	const columns: ColumnDef<TeamRow>[] = [
		{
			accessorKey: "name",
			header: "Team",
			cell: ({ row }) => {
				const t = row.original;
				return (
					<div className="flex min-w-0 items-center gap-3">
						<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-ink font-display text-ui-sm font-semibold text-ink-foreground">
							{monogram(t.name)}
						</span>
						<div className="flex min-w-0 flex-col">
							<span className="truncate text-ui-md font-medium text-text-primary">
								{t.name}
							</span>
							<span className="font-mono text-ui-2xs text-text-tertiary">
								{slugifyOrEmpty(t.name)}
							</span>
						</div>
					</div>
				);
			},
		},
		{
			accessorKey: "memberCount",
			header: "Members",
			cell: ({ row }) => {
				const t = row.original;
				return (
					<div className="flex items-center gap-3">
						{t.members.length > 0 && (
							<div className="flex -space-x-2">
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
			},
		},
		{
			id: "actions",
			header: "",
			enableSorting: false,
			cell: ({ row }) => {
				const t = row.original;
				const removing = removingId === t.id;
				return (
					<div className="text-right">
						<DropdownMenu>
							<DropdownMenuTrigger
								disabled={!entitled || removing}
								render={
									<Button
										variant="ghost"
										size="icon"
										className="size-7"
										aria-label="Manage team"
										aria-busy={removing || undefined}
										disabled={!entitled || removing}
									>
										<MoreHorizontal size={16} />
									</Button>
								}
							/>
							<DropdownMenuContent align="end" className="w-44">
								<DropdownMenuItem onClick={() => setManage(t)}>
									Manage members
								</DropdownMenuItem>
								<DropdownMenuItem
									className="text-destructive focus:text-destructive"
									onClick={() => setDeleting(t)}
								>
									Delete team
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				);
			},
		},
	];

	const activeFilters = countActiveFilters(filters, DEFAULT_TEAMS_FILTERS);

	// Pending is the route skeleton's shape (B2); the route prefetches, so this is reached only when
	// the cache was evicted under the page.
	if (teamsQuery.isPending) return <PeopleListSkeleton facets={1} columns={3} />;
	// A failed first load is an ERROR, never "No teams yet" and never the upsell (B4).
	if (teamsQuery.isError && teamsQuery.data === undefined) {
		return (
			<RegionError
				title="Couldn't load teams"
				description="The team list didn't load. Nothing about your teams changed."
				onRetry={() => void teamsQuery.refetch()}
			/>
		);
	}

	const createButton = (
		<Button size="sm" onClick={() => setCreating((v) => !v)}>
			<Plus size={13} />
			Create team
		</Button>
	);
	// Without the entitlement the SAME button is shown disabled with its reason (F017) — not an
	// enabled control that opens an upgrade modal. The upsell panel below explains the plan.
	const createAction = entitled ? (
		createButton
	) : (
		<DisabledReason reason={TEAMS_GATE_REASON}>{createButton}</DisabledReason>
	);
	// The upsell IS the page body when the org is not entitled and has no teams to show; then there
	// is nothing to filter, so the filter bar is not drawn above it (F017).
	const upsellIsBody = !entitled && total === 0;
	const nameError = form.formState.errors.name?.message;

	return (
		<div aria-busy={busy}>
			<PageToolbar
				className="mb-4"
				description="Grant access to a group of members at once."
				count={rows.length}
				actions={createAction}
			/>

			{!upsellIsBody && (
				<FilterBar>
					<FilterSearch
						value={filters.search}
						onChange={(v) => set("search", v)}
						placeholder="Search teams…"
						className="w-[240px] max-w-[380px] flex-1"
					/>
					<FacetFilter
						label="Size"
						icon={Users}
						options={TEAM_SIZE_OPTIONS.map((o) => ({
							value: o.value,
							label: o.label,
							hint: String(counts[o.value] ?? 0),
						}))}
						value={filters.sizes}
						onChange={(next) => set("sizes", next)}
						searchPlaceholder="Filter size…"
						emptyText="No sizes."
					/>
					<FilterBarReset count={activeFilters} onReset={reset} />
				</FilterBar>
			)}

			{/* inline create panel */}
			{entitled && creating && (
				<form
					onSubmit={(e) => void submitCreate(e)}
					className="mb-4 rounded-lg border border-border bg-surface p-4 shadow-sm"
				>
					<p className="mb-3 text-ui-md font-medium text-text-primary">New team</p>
					<div className="flex flex-col gap-3 sm:flex-row sm:items-start">
						<div className="flex-1">
							<label
								htmlFor="team-name"
								className="mb-1.5 block text-ui-xs text-text-tertiary"
							>
								Team name
							</label>
							<input
								id="team-name"
								className={cn(settingsControl, settingsControlSize)}
								placeholder="e.g. Networking"
								autoComplete="off"
								autoFocus
								aria-invalid={nameError ? true : undefined}
								aria-describedby={nameError ? "team-name-error" : undefined}
								disabled={createTeam.isPending}
								{...form.register("name")}
							/>
							{nameError && (
								<p id="team-name-error" className="mt-1.5 text-ui-xs text-destructive">
									{nameError}
								</p>
							)}
						</div>
						<div className="flex gap-2 sm:pt-6">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => {
									setCreating(false);
									form.reset({ name: "" });
								}}
							>
								Cancel
							</Button>
							<Button type="submit" size="sm" disabled={createTeam.isPending}>
								{createTeam.isPending ? "Creating…" : "Create team"}
							</Button>
						</div>
					</div>
				</form>
			)}

			{/* table */}
			{rows.length === 0 ? (
				upsellIsBody ? (
					<FeatureUpsell feature="teams" />
				) : (
					<EmptyState
						className="border border-border bg-surface-sunken"
						icon={<Users />}
						title={total === 0 ? "No teams yet" : "No matching teams"}
						description={
							total === 0
								? "Create one to grant access to a group of members at once."
								: "No team matches these filters."
						}
						action={
							total === 0 ? undefined : (
								<Button variant="outline" size="sm" onClick={reset}>
									Clear filters
								</Button>
							)
						}
					/>
				)
			) : (
				<div
					className={cn(
						teamsQuery.isPlaceholderData && "opacity-60 transition-opacity",
					)}
				>
					<DataTable columns={columns} data={rows} pageSize={10} />
				</div>
			)}

			{manageRow && (
				<ManageTeamDialog
					team={manageRow}
					open={manage !== null}
					onOpenChange={(o) => !o && setManage(null)}
				/>
			)}

			<AlertDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete this team?</AlertDialogTitle>
						<AlertDialogDescription>
							This removes the team and its membership. Grants made to the team are
							revoked. Members keep their own roles. This cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (deleting) removeTeam.mutate({ teamId: deleting.id });
								setDeleting(null);
							}}
							variant="destructive"
						>
							Delete team
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
