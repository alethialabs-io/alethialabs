// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6113: the topic → key map the real-time bus (#6115) invalidates through. The jobs topic must
// cover every jobs read on the router (a prefix key), or a live job change would leave a page stale.

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { orpc } from "@/lib/rpc/client";
import { TOPIC_KEYS } from "@/lib/query/topics";

describe("TOPIC_KEYS", () => {
	it("invalidates every jobs.page read, whatever its input", async () => {
		const client = new QueryClient();
		// Copied into plain arrays: the cache only cares about the key's VALUE, and the typed key would
		// demand a full page payload the invalidation under test never reads.
		const a: unknown[] = [...orpc.jobs.page.queryKey({ input: { range: { preset: "7d" } } })];
		const b: unknown[] = [...orpc.jobs.page.queryKey({ input: { range: { preset: "12mo" }, statuses: ["FAILED"] } })];
		client.setQueryData(a, { rows: [] });
		client.setQueryData(b, { rows: [] });
		for (const queryKey of TOPIC_KEYS.jobs()) await client.invalidateQueries({ queryKey });
		expect(client.getQueryState(a)?.isInvalidated).toBe(true);
		expect(client.getQueryState(b)?.isInvalidated).toBe(true);
	});

	it("...and nothing outside the jobs domain", async () => {
		const client = new QueryClient();
		client.setQueryData(["projects", "acme"], []);
		for (const queryKey of TOPIC_KEYS.jobs()) await client.invalidateQueries({ queryKey });
		expect(client.getQueryState(["projects", "acme"])?.isInvalidated).toBe(false);
	});

	it("lists every topic the bus may deliver, empty until its lane moves its reads", () => {
		expect(Object.keys(TOPIC_KEYS).sort()).toEqual(
			["addons", "alerts", "clusters", "environments", "jobs", "projects", "runners", "support", "usage"].sort(),
		);
	});
});
