// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6118: the overview page and the `[org]` layout share ONE server QueryClient per request. The
// layout hands the shell's reads (`workspace.*`) to the client; the page's boundary must hand down
// only its own (`overview.*`), or the shell's feeds are serialized into the HTML twice.

import { QueryClient, dehydrate } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { isOverviewRead } from "@/components/overview/overview-reads";
import { orpc } from "@/lib/rpc/client";

describe("the overview page's dehydrate filter", () => {
	it("hands down the overview's settled reads and none of the shell's", () => {
		const client = new QueryClient();
		// Plain arrays: the cache cares about the key's VALUE, not the typed payload.
		const usage: unknown[] = [...orpc.overview.usage.queryKey()];
		const alerts: unknown[] = [...orpc.overview.alerts.queryKey()];
		const recentJobs: unknown[] = [...orpc.workspace.recentJobs.queryKey()];
		const projects: unknown[] = [...orpc.workspace.projects.queryKey()];
		client.setQueryData(usage, { plan: "team" });
		client.setQueryData(alerts, { alerting: true, deliveries: [] });
		client.setQueryData(recentJobs, []);
		client.setQueryData(projects, []);

		const keys = dehydrate(client, { shouldDehydrateQuery: isOverviewRead }).queries.map((q) => q.queryKey);

		expect(keys).toHaveLength(2);
		expect(keys).toEqual(expect.arrayContaining([usage, alerts]));
	});

	it("does not hand down an overview read that has not settled", () => {
		const client = new QueryClient();
		client.getQueryCache().build(client, { queryKey: [...orpc.overview.usage.queryKey()] });
		expect(dehydrate(client, { shouldDehydrateQuery: isOverviewRead }).queries).toEqual([]);
	});
});
