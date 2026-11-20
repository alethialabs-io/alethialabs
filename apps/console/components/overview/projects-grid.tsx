"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The overview's project grid: one region, one read (`overview.projects`), and a distinct render
// for each thing that read can answer — pending, refused, failed, an organization with no project,
// a filter that matches none, and the projects as cards or as a table.

import type { UseQueryResult } from "@tanstack/react-query";
import { Boxes, Plus } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { Button } from "@repo/ui/button";
import { DisabledReason } from "@repo/ui/disabled-reason";
import { EmptyState } from "@repo/ui/empty";
import { Table, TableBody } from "@repo/ui/table";
import { cn } from "@repo/ui/utils";
import { MANAGE_DENIED_REASON } from "@/components/errors/manage-gate";
import { RegionError } from "@/components/errors/region-error";
import { RegionRefusal } from "@/components/errors/region-refusal";
import { useViewer } from "@/components/providers/viewer-provider";
import { useRealtimeConnection } from "@/hooks/use-realtime";
import { CLOUD_ACCOUNT, PROJECT, sentenceStart } from "@/lib/copy/vocabulary";
import { globalHref } from "@/lib/routing";
import type { OverviewProjects } from "@/lib/rpc/procedures/overview";
import { readRefusalOf } from "@/lib/rpc/refusal";
import { useFavoriteProjectIds, useProjectsStore } from "@/lib/stores/use-projects-store";
import { type OverviewState, isFiltered } from "./overview-state";
import { cloudNotOfferedReason } from "./project-cloud";
import { ProjectCard } from "./project-card";
import { ProjectRow } from "./project-row";
import { ProjectTableHeader, ProjectsSkeleton } from "./projects-skeleton";

/** Where a new project is created. */
function newProjectHref(orgSlug: string): string {
	return globalHref(orgSlug, "new");
}

/** Where a cloud account is connected: the connectors page, on its cloud connectors. */
function connectCloudHref(orgSlug: string): string {
	return `${globalHref(orgSlug, "connectors")}?type=cloud`;
}

/**
 * The grid region.
 *
 * `grid` is the page's one read of it (`useOverviewProjects`), handed down because the toolbar and
 * the usage card read the same answer. `onClearFilters` resets the search and the filters in the
 * address.
 */
export function ProjectsGrid({
	orgSlug,
	state,
	grid,
	onClearFilters,
}: {
	orgSlug: string;
	state: OverviewState;
	grid: UseQueryResult<OverviewProjects>;
	onClearFilters: () => void;
}) {
	const userId = useViewer().viewer?.id ?? null;
	const favoriteIds = useFavoriteProjectIds(userId);
	const toggleFavorite = useProjectsStore((store) => store.toggleFavorite);
	const projects = grid.data?.projects;

	// Starred projects first: a stable reorder that keeps the server's order inside each group.
	const ordered = useMemo(() => {
		if (!projects) return [];
		const starred = projects.filter((project) => favoriteIds.includes(project.id));
		const rest = projects.filter((project) => !favoriteIds.includes(project.id));
		return [...starred, ...rest];
	}, [projects, favoriteIds]);

	if (grid.data === undefined) {
		const refusal = grid.isError ? readRefusalOf(grid.error) : null;
		// Refused is not failed: the same question gets the same answer, so there is no retry.
		if (refusal) return <RegionRefusal refusal={refusal} subject={PROJECT.many} />;
		if (grid.isError) {
			return (
				<RegionError
					title="Couldn't load projects"
					description="Something went wrong loading this organization's projects."
					onRetry={() => void grid.refetch()}
				/>
			);
		}
		return (
			<div aria-busy="true" data-slot="projects-pending">
				<ProjectsSkeleton count={undefined} view={state.view} />
			</div>
		);
	}

	const { canCreate, connectedProviders, offeredClouds } = grid.data;
	const connected = connectedProviders ?? [];

	return (
		<div className="space-y-3">
			<LiveUpdatesNotice refreshing={grid.isFetching} onRefresh={() => void grid.refetch()} />
			{grid.isError ? (
				// A failed REFRESH keeps the last answer on screen, and says that it is the last one.
				<GridNotice
					role="alert"
					text="Couldn't refresh projects. This is the last list that loaded."
					action="Try again"
					busy={grid.isFetching}
					onAction={() => void grid.refetch()}
				/>
			) : null}

			{/* Dimmed while a changed search or filter is being answered: the rows on screen are the
			    previous answer's (`keepPreviousData`). */}
			<div className={cn("transition-opacity", grid.isPlaceholderData && "opacity-60")}>
				{ordered.length === 0 ? (
					isFiltered(state) ? (
						// The organization may well HAVE projects; this view resolved to none. "No projects
						// yet" here would read as data loss.
						<EmptyState
							title="No projects match your filters"
							description="Widen or clear the search, cloud and repository filters."
							action={
								<Button variant="outline" size="sm" onClick={onClearFilters}>
									Clear filters
								</Button>
							}
						/>
					) : (
						<FirstProject
							orgSlug={orgSlug}
							canCreate={canCreate}
							// `null` means the connected accounts could not be read: say nothing about them.
							needsCloudAccount={connectedProviders !== null && connectedProviders.length === 0}
						/>
					)
				) : state.view === "table" ? (
					<div className="overflow-x-auto rounded-xl border border-border/60">
						<Table>
							<ProjectTableHeader />
							<TableBody>
								{ordered.map((project) => (
									<ProjectRow
										key={project.id}
										project={project}
										orgSlug={orgSlug}
										isFavorite={favoriteIds.includes(project.id)}
										onToggleFavorite={userId ? () => toggleFavorite(userId, project.id) : undefined}
										providerConnected={project.cloud_provider !== null && connected.includes(project.cloud_provider)}
										cloudUnavailable={cloudNotOfferedReason(project.cloud_provider, offeredClouds)}
									/>
								))}
							</TableBody>
						</Table>
					</div>
				) : (
					<div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(238px,1fr))]">
						{ordered.map((project) => (
							<ProjectCard
								key={project.id}
								project={project}
								orgSlug={orgSlug}
								isFavorite={favoriteIds.includes(project.id)}
								onToggleFavorite={userId ? () => toggleFavorite(userId, project.id) : undefined}
								providerConnected={project.cloud_provider !== null && connected.includes(project.cloud_provider)}
								cloudUnavailable={cloudNotOfferedReason(project.cloud_provider, offeredClouds)}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * An organization with no project: what a project is for, in one sentence, and the next step.
 *
 * With no cloud account connected the next step is to connect one, because a project is planned
 * and deployed into one; creating the project stays on offer beside it. A viewer who may not
 * create a project sees the control disabled with the reason, not a page with nothing to do.
 */
function FirstProject({
	orgSlug,
	canCreate,
	needsCloudAccount,
}: {
	orgSlug: string;
	canCreate: boolean;
	needsCloudAccount: boolean;
}) {
	const variant = needsCloudAccount ? "outline" : "default";
	const label = (
		<>
			<Plus aria-hidden />
			Create a {PROJECT.one}
		</>
	);
	const create = canCreate ? (
		<Button size="sm" variant={variant} nativeButton={false} render={<Link href={newProjectHref(orgSlug)} />}>
			{label}
		</Button>
	) : (
		<DisabledReason reason={MANAGE_DENIED_REASON}>
			<Button size="sm" variant={variant}>
				{label}
			</Button>
		</DisabledReason>
	);
	return (
		<EmptyState
			data-state="first-run"
			icon={<Boxes aria-hidden />}
			title={`No ${PROJECT.many} yet`}
			description={
				needsCloudAccount
					? `Connect a ${CLOUD_ACCOUNT.one}, then create a ${PROJECT.one} to design, plan and deploy your infrastructure in it.`
					: `Create a ${PROJECT.one} to design, plan and deploy your infrastructure.`
			}
			action={
				<div className="flex flex-wrap items-center justify-center gap-2">
					{needsCloudAccount ? (
						<Button size="sm" nativeButton={false} render={<Link href={connectCloudHref(orgSlug)} />}>
							Connect a {CLOUD_ACCOUNT.one}
						</Button>
					) : null}
					{create}
				</div>
			}
		/>
	);
}

/**
 * Says that the organization's change stream is down, and offers the read by hand.
 *
 * The grid is live through that stream (a status changes without a reload). While it is down for
 * longer than a blip the statuses on screen may be behind, which the viewer cannot tell from the
 * grid itself. The shell's own line says the stream is retrying; this one is beside the data it
 * affects and carries the action. Nothing is shown once the session has ended or the address is no
 * longer the viewer's: the shell handles both.
 */
function LiveUpdatesNotice({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) {
	const { state, noticeable } = useRealtimeConnection();
	if (!noticeable || state === "live" || state === "signed-out" || state === "removed") return null;
	return (
		<GridNotice
			role="status"
			text={`Live updates are disconnected, so a ${PROJECT.one}'s status here may be out of date.`}
			action="Refresh"
			busy={refreshing}
			onAction={onRefresh}
		/>
	);
}

/** One line above the grid: what is wrong, and the one thing to do about it. */
function GridNotice({
	role,
	text,
	action,
	busy,
	onAction,
}: {
	role: "status" | "alert";
	text: string;
	action: string;
	busy: boolean;
	onAction: () => void;
}) {
	return (
		<div
			role={role}
			data-slot="grid-notice"
			className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-border px-3 py-2"
		>
			<span className="text-ui-sm text-muted-foreground">{text}</span>
			<Button variant="outline" size="xs" disabled={busy} onClick={onAction}>
				{busy ? "Refreshing…" : action}
			</Button>
		</div>
	);
}

/** The heading over the grid: the vocabulary's noun, as a heading. */
export const PROJECTS_HEADING = sentenceStart(PROJECT.many);
