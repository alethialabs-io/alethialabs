// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A filtered link must render filtered on its FIRST answer (#4939, the audit's F8).
//
// `~/connectors?health=connected` in a fresh tab kept the param and rendered the whole catalog:
// only the pristine query was seeded from the RSC props, so the filtered key arrived empty and
// `keepPreviousData` held the full list up until a server action re-read everything. The seed is
// now built for every query. Both directions are pinned: a filtered seed is filtered AND stale on
// arrival (so the fetch still runs), and the pristine seed keeps the query's own freshness.

import { describe, expect, it } from "vitest";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import {
	normalizeConnectorQuery,
	DEFAULT_CONNECTOR_FILTERS,
	seedConnectorsQuery,
} from "@/components/connectors/connectors-query";

/** One observability connector, connected or not. */
function connector(slug: string, connected: boolean): ConnectorWithConnection {
	return {
		id: slug,
		slug,
		name: slug,
		description: `${slug} connector.`,
		category: "observability",
		auth_method: "api_key",
		organization: slug,
		icon_url: `/icons/${slug}.png`,
		docs_url: null,
		support_url: null,
		privacy_url: null,
		status: "active",
		sort_order: 0,
		created_at: null,
		updated_at: null,
		connected,
		connection_details: null,
		group: "observability",
	};
}

const catalog = [connector("datadog", true), connector("grafana", false), connector("honeycomb", false)];

describe("seedConnectorsQuery", () => {
	it("seeds a FILTERED query from the catalog, filtered, and stale on arrival", () => {
		const query = normalizeConnectorQuery({ ...DEFAULT_CONNECTOR_FILTERS, health: ["connected"] });
		const seed = seedConnectorsQuery(catalog, query);
		const view = seed.initialData();
		expect(view.rows.map((r) => r.slug)).toEqual(["datadog"]);
		// The facet universe is the UNFILTERED catalog — the filter standard's server half.
		expect(view.total).toBe(3);
		expect(seed.initialDataUpdatedAt).toBe(0);
	});

	it("seeds the pristine query with every row and the query's own freshness", () => {
		const query = normalizeConnectorQuery(DEFAULT_CONNECTOR_FILTERS);
		const seed = seedConnectorsQuery(catalog, query);
		expect(seed.initialData().rows).toHaveLength(3);
		expect(seed.initialDataUpdatedAt).toBeUndefined();
	});
});
