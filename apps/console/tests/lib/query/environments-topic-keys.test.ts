// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6120 — the Environments page is live by default (ADR 0005 §7 Q3): each of its reads is invalidated
// by a topic on the org's change stream instead of a poll. An environment, a promotion, an approval
// slot or a protection rule changing is an `environments` hint (lib/db/programmables.sql); a job
// ending moves a promotion and the reconcile badges, so a `jobs` hint reaches the page too — but not
// the two dialog reads, which no job changes.

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { TOPIC_KEYS } from "@/lib/query/topics";
import type { Topic } from "@/lib/realtime/topics";
import { orpc } from "@/lib/rpc/client";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ENV_A = "22222222-2222-4222-8222-222222222222";
const ENV_B = "33333333-3333-4333-8333-333333333333";

/** One cached entry per Environments read (plain arrays: the cache only cares about the key's VALUE). */
function pageKeys(): Record<string, unknown[]> {
	return {
		overview: [...orpc.environments.overview.queryKey({ input: { project: "payments" } })],
		protectionRules: [
			...orpc.environments.protectionRules.queryKey({
				input: { projectId: PROJECT, environmentId: ENV_A },
			}),
		],
		promotionPreview: [
			...orpc.environments.promotionPreview.queryKey({
				input: { projectId: PROJECT, sourceId: ENV_A, targetId: ENV_B, includeRemovals: false },
			}),
		],
		switcher: [...orpc.workspace.environments.queryKey({ input: { project: "payments" } })],
	};
}

/** Which of the page's reads a hint on `topic` invalidates. */
async function invalidatedBy(topic: Topic): Promise<string[]> {
	const client = new QueryClient();
	const keys = pageKeys();
	for (const key of Object.values(keys)) client.setQueryData(key, {});
	for (const queryKey of TOPIC_KEYS[topic]()) await client.invalidateQueries({ queryKey });
	return Object.entries(keys)
		.filter(([, key]) => client.getQueryState(key)?.isInvalidated)
		.map(([name]) => name)
		.sort();
}

describe("TOPIC_KEYS — the Environments page's reads (#6120)", () => {
	it("an environment, promotion, approval or protection-rule change reaches every read on the page and the switcher", async () => {
		expect(await invalidatedBy("environments")).toEqual([
			"overview",
			"promotionPreview",
			"protectionRules",
			"switcher",
		]);
	});

	it("a job change reaches the page's read (promotion progress, reconcile badges) and nothing else of it", async () => {
		expect(await invalidatedBy("jobs")).toEqual(["overview"]);
	});

	it.each(["projects", "clusters", "runners", "fleet", "addons", "alerts", "support", "usage", "billing", "organization"] as const)(
		"a %s hint touches none of the page's reads",
		async (topic) => {
			expect(await invalidatedBy(topic)).toEqual([]);
		},
	);
});
