// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6127: what the change stream's `jobs`, `usage` and `billing` hints invalidate on the usage and
// billing pages. The split is by COST: `usage` (AI spend, at most once per 30 s per org) must
// never refetch a Stripe-backed read; `billing` (rare, Stripe-driven) refreshes every billing read;
// neither touches the live price list.

import { QueryClient, type QueryKey } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { TOPIC_KEYS } from "@/lib/query/topics";
import type { Topic } from "@/lib/realtime/topics";
import { orpc } from "@/lib/rpc/client";

/** Every billing/usage read key the pages make, by name. */
const KEYS: Record<string, QueryKey> = {
	summary: orpc.billing.summary.queryKey(),
	paymentMethods: orpc.billing.paymentMethods.queryKey(),
	recentInvoices: orpc.billing.invoices.queryKey({ input: { limit: 5 } }),
	transactions: orpc.billing.transactions.queryKey(),
	planHistory: orpc.billing.planHistory.queryKey(),
	liveAiPrices: orpc.billing.liveAiPrices.queryKey(),
	org: orpc.usage.org.queryKey(),
	resources: orpc.usage.resources.queryKey(),
	overTime: orpc.usage.overTime.queryKey({ input: { range: { preset: "30d" } } }),
	ai: orpc.usage.ai.queryKey(),
	project: orpc.usage.project.queryKey({ input: { projectId: "p" } }),
	projectOverTime: orpc.usage.projectOverTime.queryKey({
		input: { projectId: "p", range: { preset: "7d" } },
	}),
	projectAi: orpc.usage.projectAi.queryKey({ input: { projectId: "p" } }),
};

/** The names of the reads one topic's hint invalidates. */
async function invalidatedBy(topic: Topic): Promise<string[]> {
	const client = new QueryClient();
	for (const key of Object.values(KEYS)) client.setQueryData([...key], {});
	for (const queryKey of TOPIC_KEYS[topic]()) await client.invalidateQueries({ queryKey });
	return Object.entries(KEYS)
		.filter(([, key]) => client.getQueryState([...key])?.isInvalidated)
		.map(([name]) => name)
		.sort();
}

describe("TOPIC_KEYS — usage and billing (#6127)", () => {
	it("usage refreshes the AI meters and the over-time charts — database reads only", async () => {
		expect(await invalidatedBy("usage")).toEqual(
			["ai", "overTime", "projectAi", "projectOverTime"].sort(),
		);
	});

	it("billing refreshes every billing read and the usage a plan change moves", async () => {
		expect(await invalidatedBy("billing")).toEqual(
			["ai", "org", "paymentMethods", "planHistory", "recentInvoices", "summary", "transactions"].sort(),
		);
	});

	it("a job's change moves runner minutes and concurrency — NOT the 12-month charts", async () => {
		// A busy org hints `jobs` about once a second; refetching a year of daily buckets per visible
		// Usage tab on each is the cost this keeps out (#6209 review).
		expect(await invalidatedBy("jobs")).toEqual(["org", "project"].sort());
	});

	it.each(["jobs", "usage", "billing"] as const)("%s never refetches the live price list", async (topic) => {
		expect(await invalidatedBy(topic)).not.toContain("liveAiPrices");
	});
});
