// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The connected-agents board as data (AGT-L2, SPEC §5a): which cards it shows, in what order, what
// each card's meta row says, and what the search and the Status facet leave on it. No React, so
// every rule here is a unit test away.
//
// WHAT THE BOARD IS. Every app in the known-agent catalogue (lib/agents/catalog.ts), connected or
// not, plus every app the person connected that the catalogue does not know. One card per live
// grant; a catalogue app with no grant is one "Not connected" card. Connected cards sort first.
//
// WHY THE FILTER RUNS HERE AND NOT ON THE SERVER. The board's read (`agents.connected`) answers the
// whole universe in one go — the static catalogue plus the person's own live grants in this org —
// and takes no input. Search and Status narrow that answer in memory, and the facet counts are
// taken over the UNFILTERED board, so picking an option never makes it vanish.

import type { AgentApp } from "@/lib/agents/catalog";
import type { ConnectedAgent } from "@/lib/agents/grants";
import type { AgentScope } from "@/lib/approvals/types";

/** The Status facet's values. */
export const AGENT_STATUS_OPTIONS = [
	{ value: "connected", label: "Connected" },
	{ value: "not-connected", label: "Not connected" },
] as const;

/** One of {@link AGENT_STATUS_OPTIONS}. */
export type AgentStatus = (typeof AGENT_STATUS_OPTIONS)[number]["value"];

/** One card on the board. */
export interface AgentCardEntry {
	/** Stable React key: the grant id, or `app:<slug>` for an unconnected catalogue app. */
	key: string;
	/** The app's name. */
	name: string;
	/** One line saying what the app is. */
	description: string;
	/** The catalogue's mark slug, or null for an app the catalogue does not know. */
	mark: string | null;
	/** The icon an unknown app published, or null. */
	icon: string | null;
	/** The setup page, for a catalogue app. */
	docsPath: string | null;
	/** The live grant, when connected. */
	grant: ConnectedAgent | null;
}

/** The URL params the board's filters live in. */
const AGENT_FILTER_PARAMS = { search: "q", status: "status" } as const;

/** The board's filter selections. */
export interface AgentBoardFilters {
	search: string;
	status: AgentStatus[];
}

/** No search, no status: the whole board. */
export const DEFAULT_AGENT_FILTERS: AgentBoardFilters = { search: "", status: [] };

/** Whether `value` is one of the Status facet's values. */
export function isAgentStatus(value: string): value is AgentStatus {
	return AGENT_STATUS_OPTIONS.some((o) => o.value === value);
}

/** Reads the board's filters out of a URL's params; an unknown status value is dropped. */
export function agentFiltersFromUrl(params: Pick<URLSearchParams, "get" | "getAll">): AgentBoardFilters {
	const status = params
		.getAll(AGENT_FILTER_PARAMS.status)
		.flatMap((v) => v.split(","))
		.filter(isAgentStatus);
	return { search: params.get(AGENT_FILTER_PARAMS.search) ?? "", status: [...new Set(status)] };
}

/** The param patch that writes `filters` into the URL; a default value removes its param. */
export function agentFiltersPatch(filters: AgentBoardFilters): Record<string, string | null> {
	const search = filters.search.trim();
	return {
		[AGENT_FILTER_PARAMS.search]: search === "" ? null : filters.search,
		[AGENT_FILTER_PARAMS.status]: filters.status.length === 0 ? null : filters.status.join(","),
	};
}

/** How many filters differ from the defaults (the reset control's count). */
export function activeAgentFilters(filters: AgentBoardFilters): number {
	return (filters.search.trim() === "" ? 0 : 1) + (filters.status.length === 0 ? 0 : 1);
}

/** The description of an app the catalogue does not know, from where it says it is published. */
function unknownAppDescription(grant: ConnectedAgent): string {
	const host = grant.identity.host;
	if (grant.verified && host) return `Registered by its own metadata document at ${host}.`;
	return "Registered itself with Alethia. Its identity isn't verified.";
}

/** The board's cards, connected first, each group in catalogue order then newest connection first. */
export function buildAgentBoard(catalog: readonly AgentApp[], connected: readonly ConnectedAgent[]): AgentCardEntry[] {
	const order = new Map(catalog.map((app, i) => [app.slug, i]));
	// Catalogue apps keep the catalogue's order; unknown apps follow, newest first (the read's order,
	// which is `created_at` descending).
	const rank = new Map(
		connected.map((grant, i) => {
			const app = grant.identity.app;
			return [grant.grantId, app ? (order.get(app.slug) ?? catalog.length) : catalog.length + i];
		}),
	);
	const connectedCards: AgentCardEntry[] = [...connected]
		.sort((a, b) => (rank.get(a.grantId) ?? 0) - (rank.get(b.grantId) ?? 0))
		.map((grant) => {
			const app = grant.identity.app;
			return {
				key: grant.grantId,
				name: grant.identity.name,
				description: app ? app.description : unknownAppDescription(grant),
				mark: app?.mark ?? null,
				icon: app ? null : grant.identity.icon,
				docsPath: app?.docsPath ?? null,
				grant,
			};
		});
	const connectedSlugs = new Set(connected.flatMap((g) => (g.identity.app ? [g.identity.app.slug] : [])));
	const available: AgentCardEntry[] = catalog
		.filter((app) => !connectedSlugs.has(app.slug))
		.map((app) => ({
			key: `app:${app.slug}`,
			name: app.name,
			description: app.description,
			mark: app.mark,
			icon: null,
			docsPath: app.docsPath,
			grant: null,
		}));
	return [...connectedCards, ...available];
}

/** A card's Status facet bucket. */
function statusOf(card: AgentCardEntry): AgentStatus {
	return card.grant ? "connected" : "not-connected";
}

/** The cards `filters` leave on the board. Search matches the name, case-insensitively. */
export function filterAgentBoard(cards: readonly AgentCardEntry[], filters: AgentBoardFilters): AgentCardEntry[] {
	const needle = filters.search.trim().toLowerCase();
	return cards.filter(
		(card) =>
			(filters.status.length === 0 || filters.status.includes(statusOf(card))) &&
			(needle === "" || card.name.toLowerCase().includes(needle)),
	);
}

/** Each Status option's count over the UNFILTERED board. */
export function agentStatusCounts(cards: readonly AgentCardEntry[]): Record<AgentStatus, number> {
	const counts: Record<AgentStatus, number> = { connected: 0, "not-connected": 0 };
	for (const card of cards) counts[statusOf(card)] += 1;
	return counts;
}

/**
 * The projects chip: "All projects", the one project's name, or "N projects". A project the viewer
 * cannot see (or that no longer exists) still counts, but is never named.
 */
export function projectsLabel(projectIds: readonly string[] | null, names: ReadonlyMap<string, string>): string {
	if (projectIds === null) return "All projects";
	if (projectIds.length === 1) return names.get(projectIds[0] ?? "") ?? "1 project";
	return `${projectIds.length} projects`;
}

/** What each scope lets an app do, in the consent screen's words (SPEC §5b). */
export const SCOPE_WORDS: Readonly<Record<AgentScope, { label: string; detail: string }>> = {
	read: { label: "See your projects", detail: "Environments, jobs, plans, costs and logs." },
	design: { label: "Change designs", detail: "Edit infrastructure designs. Nothing is created in your cloud." },
	plan: { label: "Run plans", detail: "Plans and repository scans, which use your runners." },
	apply: { label: "Ask to deploy", detail: "Every deploy waits for a person to approve it in Alethia." },
	destroy: { label: "Ask to destroy", detail: "Every destroy waits for a person, who types the environment name." },
};
