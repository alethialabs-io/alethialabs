// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6113: the topic → key map the real-time bus (#6115) invalidates through. The jobs topic must
// cover every jobs read on the router (a prefix key), or a live job change would leave a page stale.

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { orpc } from "@/lib/rpc/client";
import { TOPIC_KEYS } from "@/lib/query/topics";
import { qk } from "@/lib/query/keys";
import { TOPICS } from "@/lib/realtime/topics";

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

	it("lists exactly the topics the wire can carry (lib/realtime/topics.ts), empty until a lane moves its reads", () => {
		expect(Object.keys(TOPIC_KEYS).sort()).toEqual([...TOPICS].sort());
	});

	it("#6115: jobs also invalidates the legacy qk.jobs / qk.jobsPage / qk.job reads (still polled by #6114's hooks)", async () => {
		const client = new QueryClient();
		const legacy: unknown[][] = [
			[...qk.jobs("acme")],
			[...qk.jobsPage("acme", { status: "FAILED" })],
			[...qk.job("acme", "j1")],
			[...qk.jobStatus("acme", "j1")],
		];
		for (const key of legacy) client.setQueryData(key, {});
		client.setQueryData([...qk.runners("acme")], {});
		for (const queryKey of TOPIC_KEYS.jobs()) await client.invalidateQueries({ queryKey });
		for (const key of legacy) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
		expect(client.getQueryState([...qk.runners("acme")])?.isInvalidated).toBe(false);
	});
});
