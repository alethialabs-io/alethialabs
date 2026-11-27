"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings › Service tokens (AGT-L2-U3; design §4). The org's tokens on the console list standard:
// the filter store mirrored into the URL, the debounced search, the normalized query as the whole of
// the key, one keyset page at a time through `useKeysetList`, `<DataTable keyset>` on desktop and a
// stacked list on a phone, each followed by its `ListFooter`. No count anywhere (README → "Counts").
//
// Every manage flow opens over the list: Create token and Edit in a right-hand sheet, Revoke as a
// confirmation, and the new token in a dialog that shows it once.
//
// States: loading (the route's skeleton, then the DataTable's placeholder rows), empty (the org has
// no token: EmptyState + Create token), no match (filters exclude every token: EmptyState + Clear
// filters), error (first page failed: RegionError + retry), forbidden (a refusal while live:
// TokensNoAccess), populated.

import { useMemo, useState } from "react";
import type { CreatedServiceToken } from "@/app/server/actions/agents/service-tokens";
import { DataTable } from "@/components/data-table";
import { RegionError } from "@repo/ui/region-error";
import { ListFooter } from "@/components/list/list-footer";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import type { ServiceTokenEnvironmentRef, ServiceTokenListItem } from "@/lib/queries/service-tokens";
import { useKeysetList } from "@/lib/query/use-keyset-list";
import { orpc } from "@/lib/rpc/client";
import { readRefusalOf } from "@/lib/rpc/refusal";
import { useServiceTokenFilters } from "@/lib/stores/use-service-token-filters";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { cn } from "@repo/ui/utils";
import { KeyRound, Plus, SearchX } from "lucide-react";
import { CreateTokenSheet } from "./create-token-sheet";
import { EditTokenSheet } from "./edit-token-sheet";
import { RevokeTokenDialog } from "./revoke-token-dialog";
import { buildTokenColumns, TokenStackedList } from "./token-columns";
import { TokenCreatedDialog } from "./token-created-dialog";
import { TokensFilterBar } from "./tokens-filter-bar";
import { DEFAULT_SERVICE_TOKEN_FILTERS, normalizeServiceTokensQuery } from "./tokens-filters";
import { TokensNoAccess } from "./tokens-no-access";

/** The toolbar's one line (design §4, final copy). */
const DESCRIPTION =
	"Tokens let pipelines and scripts use Alethia without a person signed in. Each one is limited to what you choose.";

/** The service tokens page. `canManageAgents` is the PDP's answer, asked by the route. */
export function ServiceTokensPage({ canManageAgents }: { canManageAgents: boolean }) {
	const filters = useServiceTokenFilters((s) => s.filters);
	const set = useServiceTokenFilters((s) => s.set);
	const reset = useServiceTokenFilters((s) => s.reset);
	const urlRead = useFilterUrlSync(useServiceTokenFilters, DEFAULT_SERVICE_TOKEN_FILTERS);
	const debouncedSearch = useDebouncedValue(filters.search, 250, { urlRead });

	// The normalized query IS the key; the route builds the same object from the same link.
	const view = useMemo(() => ({ ...filters, search: debouncedSearch }), [filters, debouncedSearch]);
	const input = useMemo(() => normalizeServiceTokensQuery(view), [view]);
	const list = useKeysetList(orpc.agents.serviceTokens, input);

	const [creating, setCreating] = useState(false);
	const [editing, setEditing] = useState<ServiceTokenListItem | null>(null);
	const [revoking, setRevoking] = useState<ServiceTokenListItem | null>(null);
	const [created, setCreated] = useState<{ token: CreatedServiceToken; autoApprove: ServiceTokenEnvironmentRef[] } | null>(
		null,
	);

	const columns = useMemo(() => buildTokenColumns({ onEdit: setEditing, onRevoke: setRevoking }), []);

	const firstRun = !list.isPending && list.universeEmpty === true;
	const noMatch = !list.isPending && list.universeEmpty === false && list.rows.length === 0;
	const busy = !urlRead || list.isPending || list.isPlaceholderData || filters.search !== debouncedSearch;
	const firstPageFailed = list.query.isError && list.query.data === undefined;
	const refusal = firstPageFailed ? readRefusalOf(list.query.error) : null;

	const createButton = (
		<Button size="sm" onClick={() => setCreating(true)}>
			<Plus className="mr-1.5 size-3.5" aria-hidden />
			Create token
		</Button>
	);

	return (
		<div className="space-y-6" aria-busy={busy}>
			{refusal === "forbidden" ? (
				<TokensNoAccess />
			) : firstPageFailed ? (
				<RegionError
					className="min-h-[40vh]"
					title="Couldn't load service tokens"
					description="Something went wrong fetching this organization's tokens. Your tokens keep working; try again."
					onRetry={() => void list.query.refetch()}
				/>
			) : firstRun ? (
				<>
					<PageToolbar description={DESCRIPTION} />
					<EmptyState
						className="min-h-[40vh]"
						data-state="first-run"
						icon={<KeyRound />}
						level={2}
						title="No service tokens"
						description={
							<>
								Create one for your CI pipeline. Use it as <span className="font-mono">ALETHIA_TOKEN</span> with the
								Alethia CLI.
							</>
						}
						action={createButton}
					/>
				</>
			) : (
				<>
					<PageToolbar description={DESCRIPTION} actions={createButton} />
					<TokensFilterBar filters={filters} onFilter={set} onReset={reset} facets={list.facets ?? undefined} />
					{noMatch ? (
						<EmptyState
							className="min-h-[30vh]"
							data-state="no-match"
							icon={<SearchX />}
							level={2}
							title="No tokens match these filters"
							description="Every token in this organization is excluded by the current search or status."
							action={
								<Button variant="outline" size="sm" onClick={reset}>
									Clear filters
								</Button>
							}
						/>
					) : (
						<div className={cn("transition-opacity", list.isPlaceholderData && "opacity-60")}>
							<div className="hidden md:block">
								{/* The last column is the row's Edit and Revoke: it scrolls into reach rather than being clipped (#7713). */}
								<DataTable columns={columns} keyset={list} skeletonRows={3} scrollX />
							</div>
							<div className="md:hidden">
								{list.isPending ? null : (
									<div className="space-y-3">
										<TokenStackedList rows={list.rows} actions={{ onEdit: setEditing, onRevoke: setRevoking }} />
										<ListFooter list={list} />
									</div>
								)}
							</div>
						</div>
					)}
				</>
			)}

			<CreateTokenSheet
				open={creating}
				onOpenChange={setCreating}
				canManageAgents={canManageAgents}
				onCreated={(token, autoApprove) => setCreated({ token, autoApprove })}
			/>
			<EditTokenSheet token={editing} onOpenChange={(open) => (open ? undefined : setEditing(null))} canManageAgents={canManageAgents} />
			<RevokeTokenDialog token={revoking} onClose={() => setRevoking(null)} />
			<TokenCreatedDialog
				token={created?.token ?? null}
				autoApprove={created?.autoApprove ?? []}
				onClose={() => setCreated(null)}
			/>
		</div>
	);
}
