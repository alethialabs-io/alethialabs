// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure, client-safe filter/query plumbing for the connectors board — the console filter
// standard's "normalize" step (lib/query/README.md → "Server-side filters"). No React, no
// DB imports, no server actions: the card, the row, the detail sheet and the filter bar all
// read their status wording and their facet buckets from here, so a connector can never be
// filtered into one bucket while its tile says something else.

import {
	Activity,
	Cloud,
	Container,
	GitBranch,
	Globe,
	KeyRound,
	Package,
	type LucideIcon,
} from "lucide-react";
import type {
	ConnectorGroup,
	ConnectorWithConnection,
} from "@/app/server/actions/connectors";

/**
 * The presentation groups the board renders, in display order. One entry per
 * `ConnectorGroup`; the section headings and the Group facet both read this list, so a new
 * group appears in both places or in neither.
 */
export const GROUP_META: {
	id: ConnectorGroup;
	label: string;
	description: string;
	icon: LucideIcon;
	docsHref: string;
}[] = [
	{
		id: "clouds",
		label: "Clouds",
		description:
			"Provider accounts Alethia provisions into, via short-lived federated credentials.",
		icon: Cloud,
		docsHref: "/docs/console/connectors",
	},
	{
		id: "source",
		label: "Source",
		description:
			"Git providers Alethia reads repositories from and wires GitOps deployments through.",
		icon: GitBranch,
		docsHref: "/docs/console/connectors/git-providers",
	},
	{
		id: "registries",
		label: "Registries",
		description:
			"Container registries clusters pull from. Pull credentials are injected & rotated automatically.",
		icon: Container,
		docsHref: "/docs/console/connectors/pluggable",
	},
	{
		id: "chart_repos",
		label: "Chart Repos",
		description:
			"Private Helm chart repositories (OCI or HTTPS) ArgoCD pulls add-on & BYO charts from. Repo credentials are seeded automatically at deploy.",
		icon: Package,
		docsHref: "/docs/console/connectors/pluggable",
	},
	{
		id: "secrets",
		label: "Secrets",
		description:
			"External secret stores Projects read secrets from at deploy time — fetched just-in-time, never written to state.",
		icon: KeyRound,
		docsHref: "/docs/console/connectors/pluggable",
	},
	{
		id: "observability",
		label: "Observability",
		description:
			"External destinations Alethia ships cluster metrics, logs, and traces to.",
		icon: Activity,
		docsHref: "/docs/console/connectors/pluggable",
	},
	{
		id: "dns",
		label: "DNS",
		description:
			"DNS providers Alethia manages records and certificates through.",
		icon: Globe,
		docsHref: "/docs/console/connectors/pluggable",
	},
];

/** Every group id, in display order — the Group facet's option universe. */
export const CONNECTOR_GROUP_VALUES: ConnectorGroup[] = GROUP_META.map(
	(g) => g.id,
);

const GROUP_LABEL = new Map<string, string>(
	GROUP_META.map((g) => [g.id, g.label]),
);

/** Display label for a group id (falls back to the raw id for an unknown group). */
export function groupLabel(id: string): string {
	return GROUP_LABEL.get(id) ?? id;
}

/**
 * The five buckets a connector can be in on the board. Deliberately coarser than the status
 * WORDING: "Needs reconnection", "Verification failed", "Verifying…" and "Limited permissions"
 * are four different things to say and one thing to filter for — something needs a human.
 */
export const CONNECTOR_HEALTH_VALUES = [
	"connected",
	"attention",
	"disconnected",
	"unavailable",
	"coming_soon",
] as const;

export type ConnectorHealth = (typeof CONNECTOR_HEALTH_VALUES)[number];

const HEALTH_LABEL: Record<ConnectorHealth, string> = {
	connected: "Connected",
	attention: "Needs attention",
	disconnected: "Not connected",
	unavailable: "Unavailable here",
	coming_soon: "Coming soon",
};

/** Display label for one health bucket (the Status chips). */
export function healthLabel(health: ConnectorHealth): string {
	return HEALTH_LABEL[health];
}

/**
 * One connector's resolved state: the facet bucket it filters into, and the exact words the
 * card / row / sheet print for it. Both come from this one function so the filter and the
 * label can never drift — the card used to compute the wording inline and the row kept its
 * own copy of the same ladder.
 */
export interface ConnectorState {
	health: ConnectorHealth;
	/** The status wording shown on the tile. Short enough not to need truncating. */
	label: string;
	/** True when the state is an error the user should read as one. */
	destructive: boolean;
}

/**
 * Resolve a connector's state. `platformConfigured` is false when THIS instance lacks the
 * platform credentials (or OAuth app) the connector's connect flow needs — a connect could
 * only fail, so the tile says so rather than offering a dead button.
 */
export function connectorState(
	integration: ConnectorWithConnection,
	platformConfigured = true,
): ConnectorState {
	const isConnected = integration.connected;
	// `coming_soon` only matters when NOT already connected: a connector can be marked coming
	// soon (DO/Civo lack provisioning templates) and still hold a live account from before,
	// which must keep its Manage → disconnect path.
	if (integration.status === "coming_soon" && !isConnected) {
		return { health: "coming_soon", label: HEALTH_LABEL.coming_soon, destructive: false };
	}
	const isCloud = integration.category === "cloud";
	const isGit = integration.category === "git";
	if ((isCloud || isGit) && !platformConfigured && !isConnected) {
		return {
			health: "unavailable",
			label: "Not enabled on this instance",
			destructive: false,
		};
	}
	if (
		integration.token_health === "expired" ||
		integration.token_health === "refresh_failed"
	) {
		return { health: "attention", label: "Needs reconnection", destructive: false };
	}
	if (isConnected) {
		// Degraded is NOT a synonym for disconnected: the account authenticated and is usable,
		// it just cannot see everything we would provision into. It still wants a human, so it
		// buckets under `attention` while reading as connected.
		return integration.cloud_health === "degraded"
			? { health: "attention", label: "Limited permissions", destructive: false }
			: { health: "connected", label: HEALTH_LABEL.connected, destructive: false };
	}
	if (integration.cloud_health === "failed") {
		return { health: "attention", label: "Verification failed", destructive: true };
	}
	if (integration.cloud_health === "testing") {
		return { health: "attention", label: "Verifying…", destructive: false };
	}
	return { health: "disconnected", label: HEALTH_LABEL.disconnected, destructive: false };
}

/** The board's filter state (the shape its zustand store holds). */
export type ConnectorFilters = {
	search: string;
	groups: string[];
	health: string[];
	vendors: string[];
};

/** Pristine filters — the store's defaults and the Reset target. */
export const DEFAULT_CONNECTOR_FILTERS: ConnectorFilters = {
	search: "",
	groups: [],
	health: [],
	vendors: [],
};

/**
 * The stable query object placed in the TanStack key (`qk.connectors(org, query)`). Only
 * non-empty fields are present and arrays are sorted + deduped, so two equivalent filter
 * states always produce an identical key — an unsorted array fragments the cache into keys
 * that never hit.
 */
export interface NormalizedConnectorQuery {
	search?: string;
	groups?: string[];
	health?: string[];
	vendors?: string[];
}

/** Sorted, deduped copy of a selection — or undefined when empty. */
function normalizeList(values: string[]): string[] | undefined {
	if (values.length === 0) return undefined;
	return [...new Set(values)].sort();
}

/** Normalize filter state into the stable query object (trim, sort, drop empties). */
export function normalizeConnectorQuery(
	filters: ConnectorFilters,
): NormalizedConnectorQuery {
	const query: NormalizedConnectorQuery = {};
	const search = filters.search.trim();
	if (search) query.search = search;
	const groups = normalizeList(filters.groups);
	if (groups) query.groups = groups;
	const health = normalizeList(filters.health);
	if (health) query.health = health;
	const vendors = normalizeList(filters.vendors);
	if (vendors) query.vendors = vendors;
	return query;
}

/** True when nothing is filtered — the key with no query object appended. */
export function isPristineQuery(query: NormalizedConnectorQuery): boolean {
	return Object.keys(query).length === 0;
}

/** One facet option and how many rows fall under it in the UNFILTERED universe. */
export interface ConnectorFacetOption {
	value: string;
	label: string;
	count: number;
}

/** Facet option lists, counted over the unfiltered universe. */
export interface ConnectorFacets {
	groups: ConnectorFacetOption[];
	health: ConnectorFacetOption[];
	vendors: ConnectorFacetOption[];
}

/** What the board renders: the matching rows plus facet counts and the universe size. */
export interface ConnectorsView {
	/** The query these rows answer — carried so a cache write can rebuild the same view. */
	query: NormalizedConnectorQuery;
	rows: ConnectorWithConnection[];
	facets: ConnectorFacets;
	/** Rows in the unfiltered universe (the "of M" the count pill is a fraction of). */
	total: number;
}

/** Does one connector match the free-text term (name, description, vendor, slug)? */
function matchesSearch(i: ConnectorWithConnection, term: string): boolean {
	return (
		i.name.toLowerCase().includes(term) ||
		i.description.toLowerCase().includes(term) ||
		i.organization.toLowerCase().includes(term) ||
		i.slug.toLowerCase().includes(term)
	);
}

/**
 * Apply a normalized query to the catalog. Pure, so the same predicate can run wherever the
 * rows come from — today the page's query hook, and unchanged if `getConnectorsWithStatus`
 * grows a query argument and filters in SQL.
 */
export function selectConnectors(
	rows: ConnectorWithConnection[],
	query: NormalizedConnectorQuery,
	platformConfigured: Record<string, boolean> = {},
): ConnectorWithConnection[] {
	const term = query.search?.toLowerCase();
	const groups = query.groups ? new Set(query.groups) : null;
	const health = query.health ? new Set(query.health) : null;
	const vendors = query.vendors ? new Set(query.vendors) : null;
	return rows.filter((i) => {
		if (groups && !groups.has(i.group)) return false;
		if (vendors && !vendors.has(i.organization)) return false;
		if (health) {
			const state = connectorState(i, platformConfigured[i.slug] ?? true);
			if (!health.has(state.health)) return false;
		}
		if (term && !matchesSearch(i, term)) return false;
		return true;
	});
}

/** Count occurrences of a key across the universe. */
function tally(
	rows: ConnectorWithConnection[],
	keyOf: (i: ConnectorWithConnection) => string,
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const row of rows) {
		const key = keyOf(row);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

/**
 * Facet options counted over the UNFILTERED universe — options must not disappear as they
 * are selected (console filter standard, step 6). Groups and health keep their declared
 * order; vendors sort alphabetically.
 */
export function buildConnectorFacets(
	rows: ConnectorWithConnection[],
	platformConfigured: Record<string, boolean> = {},
): ConnectorFacets {
	const byGroup = tally(rows, (i) => i.group);
	const byHealth = tally(
		rows,
		(i) => connectorState(i, platformConfigured[i.slug] ?? true).health,
	);
	const byVendor = tally(rows, (i) => i.organization);
	return {
		groups: CONNECTOR_GROUP_VALUES.map((value) => ({
			value,
			label: groupLabel(value),
			count: byGroup.get(value) ?? 0,
		})).filter((o) => o.count > 0),
		health: CONNECTOR_HEALTH_VALUES.map((value) => ({
			value,
			label: healthLabel(value),
			count: byHealth.get(value) ?? 0,
		})).filter((o) => o.count > 0),
		vendors: [...byVendor.entries()]
			.map(([value, count]) => ({ value, label: value, count }))
			.sort((a, b) => a.label.localeCompare(b.label)),
	};
}

/** The whole view for one query: matching rows + facets over the unfiltered universe. */
export function buildConnectorsView(
	rows: ConnectorWithConnection[],
	query: NormalizedConnectorQuery,
	platformConfigured: Record<string, boolean> = {},
): ConnectorsView {
	return {
		query,
		rows: selectConnectors(rows, query, platformConfigured),
		facets: buildConnectorFacets(rows, platformConfigured),
		total: rows.length,
	};
}
