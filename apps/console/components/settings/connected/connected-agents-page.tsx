"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Connected agents (`/{org}/~/settings/connected`, AGT-L2 SPEC §5a): the MCP apps the
// signed-in person has let act for them in this org, laid out as the connectors board — every known
// app, connected or not, as a card; search and a Status facet; a manage sheet per connection; and
// Disconnect through `ConfirmAction`.
//
// ONE READ, `agents.connected`: the person's own live grants, the agent-app catalogue and the org's
// kill switch. Only the person's own — nobody sees or disconnects a teammate's connection here (O2),
// which the footnote says. Reading needs `org:view`, which every member holds, so a refusal means the
// viewer is no longer in the org.
//
// THE FILTERS LIVE IN THE URL (`?q=`, `?status=`), written in place so a filtered board is a link.
// They narrow the read's answer in memory (connected-agents-board.ts says why that is the whole
// universe), and the open sheet is `?selected=<grant id>`, so a reload or a shared link reopens it.

import { useQuery } from "@tanstack/react-query";
import { CircleDot, Power } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { disconnectAgent } from "@/app/server/actions/agents/connections";
import { ConfirmAction } from "@/components/confirm/confirm-action";
import { RegionError } from "@repo/ui/region-error";
import { AgentCard } from "@/components/settings/connected/agent-card";
import {
	AGENT_STATUS_OPTIONS,
	DEFAULT_AGENT_FILTERS,
	type AgentBoardFilters,
	activeAgentFilters,
	agentFiltersFromUrl,
	agentFiltersPatch,
	agentStatusCounts,
	buildAgentBoard,
	filterAgentBoard,
	isAgentStatus,
	projectsLabel,
} from "@/components/settings/connected/connected-agents-board";
import { ConnectedAgentsSkeleton } from "@/components/settings/connected/connected-agents-skeleton";
import { ManageAgentSheet } from "@/components/settings/connected/manage-agent-sheet";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { hrefWithParamPatch, selectionFromUrl, selectionPatch } from "@/lib/query/view-url-params";
import { orpc } from "@/lib/rpc/client";
import { readRefusalOf, retryUnlessRefused } from "@/lib/rpc/refusal";
import { useListSearchShortcut } from "@/lib/shortcuts/use-list-search-shortcut";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { FilterEmpty } from "@repo/ui/filter-bar";
import { ListToolbar } from "@repo/ui/list-toolbar";

/** Writes a param patch into the address bar in place (no server navigation, no history entry). */
function replaceParams(patch: Record<string, string | null>) {
	window.history.replaceState(null, "", hrefWithParamPatch(window.location.pathname, window.location.search, patch));
}

/** The connected-agents board: kill-switch banner, the one toolbar row, the card grid and the sheet. */
export function ConnectedAgentsPage({ orgSlug }: { orgSlug: string }) {
	const read = useQuery(orpc.agents.connected.queryOptions({ input: undefined, retry: retryUnlessRefused }));
	const projectsRead = useQuery(orpc.workspace.projects.queryOptions({ retry: retryUnlessRefused }));
	const orgName = useWorkspaceStore((s) => s.organizations.find((o) => o.id === s.activeOrgId)?.name ?? null);
	const org = orgName ?? "this organization";

	const searchParams = useSearchParams();
	const filters = agentFiltersFromUrl(searchParams);
	const selectedId = selectionFromUrl(searchParams);
	const setFilters = (next: AgentBoardFilters) => replaceParams(agentFiltersPatch(next));
	const resetFilters = () => setFilters(DEFAULT_AGENT_FILTERS);

	const board = useMemo(
		() => (read.data ? buildAgentBoard(read.data.catalog, read.data.connected) : []),
		[read.data],
	);
	const shown = useMemo(() => filterAgentBoard(board, filters), [board, filters]);
	const counts = useMemo(() => agentStatusCounts(board), [board]);
	const projectNames = useMemo(
		() => new Map((projectsRead.data ?? []).map((p) => [p.id, p.project_name])),
		[projectsRead.data],
	);

	const paused = read.data ? !read.data.agentAccessEnabled : false;
	const noneConnected = read.data ? read.data.connected.length === 0 : false;
	const managed = board.find((card) => card.grant !== null && card.grant.grantId === selectedId) ?? null;
	const [disconnecting, setDisconnecting] = useState<{ grantId: string; name: string } | null>(null);
	// `/` focuses the search while this page is mounted (polish-wave spec §3).
	const { inputRef, shortcut } = useListSearchShortcut();

	const disconnect = useActionMutation(disconnectAgent, {
		invalidates: [orpc.agents.connected.key()],
		successMessage: () => `${disconnecting?.name ?? "The app"} disconnected.`,
		onSuccess: () => replaceParams(selectionPatch(null)),
	});

	if (readRefusalOf(read.error) === "forbidden") {
		return (
			<EmptyState
				className="border border-border bg-surface"
				icon={<CircleDot />}
				title="Connected agents aren't available"
				description="You're not a member of this organization any more, or your access changed. Reload the page, or choose another organization."
			/>
		);
	}
	if (read.isError && read.data === undefined) {
		return (
			<RegionError
				title="Couldn't load your connected agents"
				description="Your connections are unchanged. Try again in a moment."
				onRetry={() => void read.refetch()}
			/>
		);
	}
	if (read.data === undefined) return <ConnectedAgentsSkeleton />;

	return (
		<div className="space-y-4">
			{paused ? (
				<Alert role="status">
					<Power aria-hidden />
					<AlertTitle>Agent access is off in {org}.</AlertTitle>
					<AlertDescription>
						<p>
							Your connections are kept but can&apos;t do anything until someone who manages agents turns access
							back on.
						</p>
						<Button
							variant="outline"
							size="sm"
							className="mt-2"
							nativeButton={false}
							render={<a href={`/${orgSlug}/~/settings/agents`} />}
						>
							Agent settings
						</Button>
					</AlertDescription>
				</Alert>
			) : null}

			{noneConnected ? (
				<p className="text-ui-sm text-text-secondary">
					You haven&apos;t connected an agent to {org} yet. Pick an app below for its setup steps, or run{" "}
					<code className="rounded border border-border px-1 font-mono text-ui-xs text-text-primary">
						alethia agent setup
					</code>
					.
				</p>
			) : null}

			<ListToolbar
				search={{
					value: filters.search,
					onChange: (search) => setFilters({ ...filters, search }),
					placeholder: "Search agents…",
					ariaLabel: "Search agents",
					inputRef,
					shortcut,
				}}
				facets={[
					{
						label: "Status",
						icon: CircleDot,
						options: AGENT_STATUS_OPTIONS.map((o) => ({
							value: o.value,
							label: o.label,
							hint: String(counts[o.value]),
						})),
						value: filters.status,
						onChange: (next: string[]) => setFilters({ ...filters, status: next.filter(isAgentStatus) }),
						searchPlaceholder: "Filter status…",
						emptyText: "No statuses.",
					},
				]}
				reset={{ count: activeAgentFilters(filters), onReset: resetFilters }}
			/>

			{shown.length === 0 ? (
				// The board is the whole agent-app catalogue, never empty, so no card is a FILTERED empty.
				<FilterEmpty noun="agents" onClear={resetFilters} />
			) : (
				<ul aria-label="Agent apps" className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
					{shown.map((card) => (
						<AgentCard
							key={card.key}
							card={card}
							projects={card.grant ? projectsLabel(card.grant.projectIds, projectNames) : null}
							paused={paused}
							onManage={() => card.grant && replaceParams(selectionPatch(card.grant.grantId))}
						/>
					))}
				</ul>
			)}

			<p className="text-ui-sm text-text-secondary">Only you can see and disconnect your connections.</p>

			<ManageAgentSheet
				card={managed}
				onOpenChange={(open) => {
					if (!open) replaceParams(selectionPatch(null));
				}}
				projectNames={projectNames}
				paused={paused}
				onDisconnect={() => managed?.grant && setDisconnecting({ grantId: managed.grant.grantId, name: managed.name })}
			/>

			<ConfirmAction
				open={disconnecting !== null}
				onOpenChange={(open) => {
					if (!open) setDisconnecting(null);
				}}
				title={`Disconnect ${disconnecting?.name ?? "this app"}?`}
				description={`${disconnecting?.name ?? "The app"} loses access to ${org} right away. Its requests waiting for approval can't be used. Jobs it already started keep running. To use it again, connect it again from the app.`}
				confirmLabel="Disconnect"
				pendingLabel="Disconnecting…"
				severity={{ level: "confirm" }}
				mutation={disconnect}
				variables={disconnecting ? { grantId: disconnecting.grantId } : null}
			/>
		</div>
	);
}
