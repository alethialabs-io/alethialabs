// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6131: what the change stream refreshes on the create flow. The scan's STATUS rides the `jobs`
// topic — that is how the Configure screen learns a scan finished without the 2.5 s poll it had. The
// scan's PROPOSAL rides nothing: it runs a model inference on every read, and a busy org hints `jobs`
// about once a second, so mapping it would re-run (and re-meter) the inference on every hint.

import { QueryClient, type QueryKey } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { TOPIC_KEYS } from "@/lib/query/topics";
import { TOPICS, type Topic } from "@/lib/realtime/topics";
import { orpc } from "@/lib/rpc/client";

const JOB = "00000000-0000-4000-8000-000000000001";

/** Every projects-domain read key the create flow and the duplicate dialog make, by name. */
const KEYS: Record<string, QueryKey> = {
	linkedGitProviders: orpc.projects.linkedGitProviders.queryKey(),
	scanStatus: orpc.projects.scanStatus.queryKey({ input: { jobId: JOB } }),
	scanProposal: orpc.projects.scanProposal.queryKey({ input: { jobId: JOB } }),
	nameAvailability: orpc.projects.nameAvailability.queryKey({ input: { name: "api" } }),
	duplicateTargets: orpc.projects.duplicateTargets.queryKey({ input: { projectId: JOB } }),
	shellProjects: orpc.workspace.projects.queryKey(),
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

describe("TOPIC_KEYS — the create flow (#6131)", () => {
	it("a job's change refreshes the scan's status, and nothing else of the create flow", async () => {
		expect(await invalidatedBy("jobs")).toEqual(["scanStatus"]);
	});

	it("a project's change refreshes every read that answers against the org's project names", async () => {
		expect(await invalidatedBy("projects")).toEqual(
			["duplicateTargets", "nameAvailability", "shellProjects"].sort(),
		);
	});

	it.each(TOPICS)("%s never refetches the scan proposal (a model inference per read)", async (topic) => {
		expect(await invalidatedBy(topic)).not.toContain("scanProposal");
	});
});
