// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6118: the overview page and the `[org]` layout share ONE server QueryClient per request. The
// layout hands the shell's reads (`workspace.*`) to the client; the page's boundary hands down its
// own (`overview.*`) — and, since #6347, exactly ONE of the shell's: the job feed the Recent-jobs
// card draws in the server HTML, which may only be drawn there when the boundary directly above the
// card carries it. Every other shell feed would only be serialized into the HTML a second time.

import { QueryClient, dehydrate } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { isOverviewPageRead, isRecentJobsKey } from "@/components/overview/overview-reads";
import { orpc } from "@/lib/rpc/client";

describe("the overview page's dehydrate filter", () => {
	it("hands down the overview's settled reads and the job feed, and none of the other shell reads", () => {
		const client = new QueryClient();
		// Plain arrays: the cache cares about the key's VALUE, not the typed payload.
		const usage: unknown[] = [...orpc.overview.usage.queryKey()];
		const alerts: unknown[] = [...orpc.overview.alerts.queryKey()];
		const recentJobs: unknown[] = [...orpc.workspace.recentJobs.queryKey()];
		const projects: unknown[] = [...orpc.workspace.projects.queryKey()];
		const context: unknown[] = [...orpc.workspace.context.queryKey()];
		client.setQueryData(usage, { plan: "team" });
		client.setQueryData(alerts, { alerting: true, deliveries: [] });
		client.setQueryData(recentJobs, []);
		client.setQueryData(projects, []);
		client.setQueryData(context, {});

		const keys = dehydrate(client, { shouldDehydrateQuery: isOverviewPageRead }).queries.map((q) => q.queryKey);

		expect(keys).toHaveLength(3);
		expect(keys).toEqual(expect.arrayContaining([usage, alerts, recentJobs]));
	});

	it("does not hand down a read that has not settled — the job feed included", () => {
		const client = new QueryClient();
		client.getQueryCache().build(client, { queryKey: [...orpc.overview.usage.queryKey()] });
		client.getQueryCache().build(client, { queryKey: [...orpc.workspace.recentJobs.queryKey()] });
		expect(dehydrate(client, { shouldDehydrateQuery: isOverviewPageRead }).queries).toEqual([]);
	});
});

describe("isRecentJobsKey — what the page reads `jobsPrefetched` off", () => {
	it("is the shell's job feed and nothing else", () => {
		expect(isRecentJobsKey(orpc.workspace.recentJobs.queryKey())).toBe(true);
		expect(isRecentJobsKey(orpc.workspace.projects.queryKey())).toBe(false);
		expect(isRecentJobsKey(orpc.overview.usage.queryKey())).toBe(false);
		// The FULL job list is a different read; the card does not draw it.
		expect(isRecentJobsKey(orpc.workspace.jobs.queryKey())).toBe(false);
	});
});
