// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The shell's reads are reachable from their real-time topics (ADR 0005 §7 Q3, #6114).
//
// The bus invalidates the keys `TOPIC_KEYS[topic]()` lists. A shell read whose key no topic reaches
// would stay stale until its poll — or forever, once the poll is deleted. Each case seeds the EXACT
// key the shell's hook reads (`orpc.workspace.*.queryOptions()`), invalidates by the topic's keys,
// and asserts that entry was invalidated: a prefix that does not match the hook's key fails here.

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { TOPIC_KEYS, type Topic } from "@/lib/query/topics";
import { orpc } from "@/lib/rpc/client";

/** The keys the shell's hooks read, each with the topic that must reach it. */
const SHELL_READS: Array<[string, Topic, readonly unknown[]]> = [
	["the job feed", "jobs", orpc.workspace.jobs.queryOptions().queryKey],
	["the setup guide, on a job", "jobs", orpc.workspace.setupGuide.queryOptions().queryKey],
	["the project list", "projects", orpc.workspace.projects.queryOptions().queryKey],
	["the setup guide, on a project", "projects", orpc.workspace.setupGuide.queryOptions().queryKey],
	[
		"the environment switcher",
		"environments",
		orpc.workspace.environments.queryOptions({ input: { project: "shop" } }).queryKey,
	],
	["the support-case feed", "support", orpc.workspace.supportCases.queryOptions().queryKey],
];

describe("TOPIC_KEYS reach the shell's reads", () => {
	it.each(SHELL_READS)("%s is invalidated by the %s topic", async (_name, topic, key) => {
		const client = new QueryClient();
		client.setQueryData(key, []);
		for (const k of TOPIC_KEYS[topic]()) await client.invalidateQueries({ queryKey: k });
		expect(client.getQueryState(key)?.isInvalidated).toBe(true);
	});

	it("an unrelated topic leaves the job feed alone", async () => {
		const client = new QueryClient();
		const key = orpc.workspace.jobs.queryOptions().queryKey;
		client.setQueryData(key, []);
		for (const k of TOPIC_KEYS.support()) await client.invalidateQueries({ queryKey: k });
		expect(client.getQueryState(key)?.isInvalidated).toBe(false);
	});
});
