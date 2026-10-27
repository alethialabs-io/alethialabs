// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6122: the clusters routes and the `[org]` layout share ONE server QueryClient per request. The
// layout hands the shell's reads (`workspace.*`) to the client; the clusters page's boundary must hand
// down only its own settled read, or the shell's feeds are serialized into the HTML twice.

import { QueryClient, dehydrate } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { isClustersRead } from "@/components/clusters/clusters-reads";
import { orpc } from "@/lib/rpc/client";

describe("the clusters routes' dehydrate filter", () => {
	it("hands down the clusters read and none of the shell's", () => {
		const client = new QueryClient();
		// Plain arrays: the cache cares about the key's VALUE, not the typed payload.
		const list: unknown[] = [...orpc.clusters.list.queryKey()];
		const projects: unknown[] = [...orpc.workspace.projects.queryKey()];
		client.setQueryData(list, []);
		client.setQueryData(projects, []);

		const keys = dehydrate(client, { shouldDehydrateQuery: isClustersRead }).queries.map((q) => q.queryKey);

		expect(keys).toEqual([list]);
	});

	it("does not hand down a clusters read that has not settled", () => {
		const client = new QueryClient();
		client.getQueryCache().build(client, { queryKey: [...orpc.clusters.list.queryKey()] });
		expect(dehydrate(client, { shouldDehydrateQuery: isClustersRead }).queries).toEqual([]);
	});
});
