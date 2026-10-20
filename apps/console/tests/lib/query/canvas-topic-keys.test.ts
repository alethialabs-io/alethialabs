// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6119 — the board is live by default (ADR 0005 §7 Q3): every read it shows that can change without
// the viewer acting is invalidated by a topic on the org's change stream, so none of them polls.
// Each case names the change that must reach the read, and what must NOT be touched by it.

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { DESTROY_HOLD_KEY } from "@/components/design-project/canvas/cards/destroy-hold-key";
import { TOPIC_KEYS } from "@/lib/query/topics";
import { orpc } from "@/lib/rpc/client";
import type { Topic } from "@/lib/realtime/topics";

const INPUT = { projectId: "11111111-1111-4111-8111-111111111111", environmentId: null };

/** One cached entry per board read (plain arrays: the cache only cares about the key's VALUE). */
function boardKeys(): Record<string, unknown[]> {
	return {
		environmentStatus: [...orpc.canvas.environmentStatus.queryKey({ input: INPUT })],
		addons: [...orpc.canvas.addons.queryKey({ input: INPUT })],
		byoCharts: [...orpc.canvas.byoCharts.queryKey({ input: INPUT })],
		chartWorkloads: [...orpc.canvas.chartWorkloads.queryKey({ input: INPUT })],
		iacSource: [...orpc.canvas.iacSource.queryKey({ input: INPUT })],
		environmentJobs: [...orpc.canvas.environmentJobs.key()],
		destroyHold: [...DESTROY_HOLD_KEY, "job-1"],
		capabilities: [...orpc.canvas.capabilities.queryKey({ input: { identityId: "x", region: null } })],
	};
}

/** Which board reads a hint on `topic` invalidates. */
async function invalidatedBy(topic: Topic): Promise<string[]> {
	const client = new QueryClient();
	const keys = boardKeys();
	for (const key of Object.values(keys)) client.setQueryData(key, {});
	for (const queryKey of TOPIC_KEYS[topic]()) await client.invalidateQueries({ queryKey });
	return Object.entries(keys)
		.filter(([, key]) => client.getQueryState(key)?.isInvalidated)
		.map(([name]) => name)
		.sort();
}

describe("TOPIC_KEYS — the board's reads (#6119)", () => {
	it("a job change reaches the status (in-flight job, cost, drift), the Activity card and a held destroy", async () => {
		expect(await invalidatedBy("jobs")).toEqual(["destroyHold", "environmentJobs", "environmentStatus"]);
	});

	it("an environment or component change reaches the status, the described workloads, the IaC source and a held destroy", async () => {
		expect(await invalidatedBy("environments")).toEqual([
			"chartWorkloads",
			"destroyHold",
			"environmentStatus",
			"iacSource",
		]);
	});

	it("an add-on change reaches the catalog, the BYO charts and the status (an installed add-on is a node)", async () => {
		expect(await invalidatedBy("addons")).toEqual(["addons", "byoCharts", "environmentStatus"]);
	});

	it("the capability catalog is touched by none of them — a sweeper refreshes it, not a row the board shows", async () => {
		for (const topic of ["jobs", "environments", "addons"] as const) {
			expect(await invalidatedBy(topic)).not.toContain("capabilities");
		}
	});
});
