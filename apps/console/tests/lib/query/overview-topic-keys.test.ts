// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6118: the overview's cards are live through the real-time bus, not a poll (ADR 0005 §7 Q3).
// Each card's key must be in the topic map for every topic that changes what the card shows.

import { QueryClient, type QueryKey } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { TOPIC_KEYS } from "@/lib/query/topics";
import { orpc } from "@/lib/rpc/client";
import type { Topic } from "@/lib/realtime/topics";

/** Whether a hint on `topic` invalidates a cached `key`. */
async function invalidates(topic: Topic, key: QueryKey): Promise<boolean> {
	const client = new QueryClient();
	client.setQueryData(key, {});
	for (const queryKey of TOPIC_KEYS[topic]()) await client.invalidateQueries({ queryKey });
	return client.getQueryState(key)?.isInvalidated === true;
}

// Copied into plain arrays: the cache cares about the key's VALUE, and the typed key would demand
// the full payload the invalidation under test never reads.
const usageKey: unknown[] = [...orpc.overview.usage.queryKey()];
const alertsKey: unknown[] = [...orpc.overview.alerts.queryKey()];
const recentJobsKey: unknown[] = [...orpc.workspace.recentJobs.queryKey()];
// The grid's read for two different addresses: a hint must reach every one of them.
const gridKey: unknown[] = [
	...orpc.overview.projects.queryKey({ input: { q: "", clouds: [], repos: [], sort: "activity" } }),
];
const filteredGridKey: unknown[] = [
	...orpc.overview.projects.queryKey({ input: { q: "shop", clouds: ["aws"], repos: [], sort: "name" } }),
];

/** The topics whose hints change something the project grid shows. */
const GRID_TOPICS: Topic[] = ["projects", "environments", "jobs", "addons", "connectors"];

describe("the overview's cards in TOPIC_KEYS", () => {
	it("Recent jobs refetches on a job change", async () => {
		expect(await invalidates("jobs", recentJobsKey)).toBe(true);
	});

	it("Usage refetches on a job change (runner minutes, jobs in flight) and on a usage hint", async () => {
		expect(await invalidates("jobs", usageKey)).toBe(true);
		expect(await invalidates("usage", usageKey)).toBe(true);
	});

	it("#6817: the project grid refetches when a project, an environment, a job, an add-on or a cloud account changes", async () => {
		const stale: string[] = [];
		for (const topic of GRID_TOPICS) {
			if (!(await invalidates(topic, gridKey))) stale.push(`${topic}: pristine`);
			if (!(await invalidates(topic, filteredGridKey))) stale.push(`${topic}: filtered`);
		}
		expect(stale).toEqual([]);
	});

	it("#6817: ...and not on a hint that changes nothing the grid shows", async () => {
		expect(await invalidates("alerts", gridKey)).toBe(false);
		expect(await invalidates("support", gridKey)).toBe(false);
	});

	it("Alerts refetches on an alerts hint — and not on a job change", async () => {
		expect(await invalidates("alerts", alertsKey)).toBe(true);
		expect(await invalidates("jobs", alertsKey)).toBe(false);
	});
});
