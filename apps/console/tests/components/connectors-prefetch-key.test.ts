// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6124 (RUBRIC B1): the route prefetches EXACTLY the key the board asks for on first paint, so the
// first paint is a cache hit and nothing is fetched on mount. The route builds its input from the
// URL (`filterStateFromUrl` → `normalizeConnectorQuery`); the board builds its input from the filter
// store once `useFilterUrlSync` has read the same URL into it. Both must land on one key — for a
// pristine link and for a filtered one. Per-provider availability is not a second input: both
// answers carry the server's own `platformConfigured` from one read (`readConnectorsBoard`).

import { describe, expect, it } from "vitest";
import {
	DEFAULT_CONNECTOR_FILTERS,
	normalizeConnectorQuery,
} from "@/components/connectors/connectors-query";
import { filterStateFromUrl, filtersFromUrl, paramReader } from "@/lib/query/filter-url-codec";
import { orpc } from "@/lib/rpc/client";

/** The input the ROUTE prefetches for a link's query string. */
function routeInput(qs: string) {
	const params = Object.fromEntries(new URLSearchParams(qs));
	return normalizeConnectorQuery(filterStateFromUrl(paramReader(params), DEFAULT_CONNECTOR_FILTERS));
}

/** The input the BOARD asks with once the URL is read into its store (useFilterUrlSync). */
function boardInput(qs: string) {
	const fromUrl = filtersFromUrl(new URLSearchParams(qs), DEFAULT_CONNECTOR_FILTERS);
	return normalizeConnectorQuery({ ...DEFAULT_CONNECTOR_FILTERS, ...fromUrl });
}

/** The query key a given input reads. */
function keyOf(input: ReturnType<typeof routeInput>) {
	return orpc.connectors.board.queryOptions({ input }).queryKey;
}

describe("connectors board — the prefetched key is the key the board reads", () => {
	it.each(["", "search=HashiCorp", "groups=clouds", "health=connected&vendors=Datadog%2C%20Inc."])(
		"link `?%s`",
		(qs) => {
			expect(keyOf(boardInput(qs))).toEqual(keyOf(routeInput(qs)));
		},
	);
});
