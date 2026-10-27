// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6122: the clusters grid is live through the real-time bus, not a poll (ADR 0005 §7 Q3). A card
// shows the cluster row AND its environment's lifecycle and data services, so both topics must
// invalidate the grid's key — and an unrelated topic must not.

import { QueryClient, type QueryKey } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { TOPIC_KEYS } from "@/lib/query/topics";
import { orpc } from "@/lib/rpc/client";
import type { Topic } from "@/lib/realtime/topics";

/** Whether a hint on `topic` invalidates a cached `key`. */
async function invalidates(topic: Topic, key: QueryKey): Promise<boolean> {
	const client = new QueryClient();
	client.setQueryData(key, []);
	for (const queryKey of TOPIC_KEYS[topic]()) await client.invalidateQueries({ queryKey });
	return client.getQueryState(key)?.isInvalidated === true;
}

// Copied into a plain array: the cache cares about the key's VALUE.
const listKey: unknown[] = [...orpc.clusters.list.queryKey()];

describe("the clusters grid in TOPIC_KEYS", () => {
	it("refetches on a cluster change", async () => {
		expect(await invalidates("clusters", listKey)).toBe(true);
	});

	it("refetches on an environment change (lifecycle, databases, caches)", async () => {
		expect(await invalidates("environments", listKey)).toBe(true);
	});

	it("does not refetch on an alerts hint", async () => {
		expect(await invalidates("alerts", listKey)).toBe(false);
	});
});
