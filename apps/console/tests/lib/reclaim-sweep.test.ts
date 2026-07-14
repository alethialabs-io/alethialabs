// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Orchestration tests for the orphan sweep. guards.test.ts proves WHAT may be deleted; this proves the
// sweep honours those decisions — that the kill switch really stops deletes, that the decision trail is
// durable BEFORE anything is destroyed, and that deletes go out in dependency order.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudResourceRef, ReclaimAdapter } from "@/lib/reclaim/types";

const deleted: string[] = [];
const stamped: Record<string, unknown>[] = [];

/** A fake cloud: three labelled resources, one of which tofu already tracks. */
function resource(over: Partial<CloudResourceRef>): CloudResourceRef {
	return {
		native_id: "x",
		kind: "server",
		name: "n",
		region: "nbg1",
		created_at: new Date("2026-07-14T12:05:00Z"),
		labels: { "alethia_environment-id": "6f2c1e34-9a77-4d18-8b21-0f5a7c9e4d10" },
		...over,
	};
}

const fakeAdapter: ReclaimAdapter = {
	provider: "hetzner",
	list: async () => [
		resource({ native_id: "net-1", kind: "network" }),
		resource({ native_id: "srv-1", kind: "server" }),
		resource({ native_id: "vol-1", kind: "volume" }),
		// Tracked by tofu state below — must survive.
		resource({ native_id: "tracked-1", kind: "server" }),
		// Older than the job — must survive. This is the prod-shaped resource.
		resource({
			native_id: "prod-1",
			kind: "server",
			created_at: new Date("2026-01-01T00:00:00Z"),
		}),
	],
	delete: async (_id, r) => {
		deleted.push(r.native_id);
	},
	deleteOrder: ["server", "volume", "network"],
};

vi.mock("@/lib/reclaim/providers", () => ({
	adapterFor: () => fakeAdapter,
}));

vi.mock("@/lib/reclaim/state", () => ({
	stateNativeIds: async () => new Set(["tracked-1"]),
}));

vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		update: () => ({
			set: (patch: Record<string, unknown>) => ({
				where: async () => {
					stamped.push(patch);
					// The plan must already be recorded by the time the first delete goes out.
					stamped[stamped.length - 1].__deletedSoFar = [...deleted];
				},
			}),
		}),
	}),
}));

vi.mock("@/lib/observability/log", () => ({
	log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/observability/heartbeats", () => ({
	registerLoop: vi.fn(),
	superviseLoop: vi.fn(),
}));
vi.mock("@/lib/storage/tofu-state", () => ({
	stateKeyForJob: () => ({ key: "projects/p/e/tofu.tfstate" }),
	TOFU_STATE_BUCKET: "project-tofu-state",
}));

import { sweepJob } from "@/lib/reclaim/sweep";

const job = {
	id: "job-1",
	provider: "hetzner",
	cloud_identity_id: "ci-1",
	project_id: "p",
	environment_id: "6f2c1e34-9a77-4d18-8b21-0f5a7c9e4d10",
	project_name: "acme-prod",
	environment_name: "7f3a",
	started_at: new Date("2026-07-14T12:00:00Z"),
	job_type: "DEPLOY",
	config_snapshot: {},
};

beforeEach(() => {
	deleted.length = 0;
	stamped.length = 0;
	delete process.env.ALETHIA_ORPHAN_RECLAIM;
});

describe("sweepJob", () => {
	// The default. A deploy that has never heard of this feature must not acquire the power to delete
	// infrastructure just by shipping.
	it("deletes NOTHING when the kill switch is off, but still records what it found", async () => {
		const decisions = await sweepJob(job);

		expect(deleted).toEqual([]);
		// It still IDENTIFIES all three orphans — report-only is useful precisely because it reports.
		expect(decisions.filter((d) => d.action === "delete")).toHaveLength(3);
		// ...and still writes the trail (plan + outcome), so an operator can see what it would have done.
		expect(stamped.length).toBeGreaterThanOrEqual(2);
	});

	it("deletes the orphans in dependency order once enabled", async () => {
		process.env.ALETHIA_ORPHAN_RECLAIM = "1";
		await sweepJob(job);

		// server → volume → network. A volume cannot be deleted while its server holds it, and a network
		// cannot be deleted with anything still in it.
		expect(deleted).toEqual(["srv-1", "vol-1", "net-1"]);
	});

	// The two survivors are the whole safety story: one is tofu's, one predates the job.
	it("never deletes a state-tracked resource or one that predates the job", async () => {
		process.env.ALETHIA_ORPHAN_RECLAIM = "1";
		await sweepJob(job);

		expect(deleted).not.toContain("tracked-1");
		expect(deleted).not.toContain("prod-1");
	});

	// If the sweep dies mid-delete, "what was it doing?" must already be answerable. So the plan is
	// written while nothing has been deleted yet.
	it("records the decision trail BEFORE it deletes anything", async () => {
		process.env.ALETHIA_ORPHAN_RECLAIM = "1";
		await sweepJob(job);

		expect(stamped.length).toBeGreaterThanOrEqual(2); // plan, then outcome
		expect(stamped[0].__deletedSoFar).toEqual([]); // nothing destroyed at plan time
		expect(stamped[stamped.length - 1].__deletedSoFar).toHaveLength(3); // outcome after
	});

	// No selector ⇒ no filter ⇒ the sweep would enumerate, and then delete from, the whole account.
	it("REFUSES to sweep when the selector cannot be derived", async () => {
		await expect(
			sweepJob({ ...job, environment_id: null }),
		).rejects.toThrow(/without a label selector/);
		expect(deleted).toEqual([]);
	});
});
