// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	projectStateKey,
	runnerStateKey,
	stateKeyForJob,
} from "@/lib/storage/tofu-state";
import type { ProvisionJobType } from "@/lib/db/schema";

const RUNNER_UUID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const FABRIC_UUID = "b2c3d4e5-f6a7-4901-bcde-f23456789012";

type JobArg = Parameters<typeof stateKeyForJob>[0];

function job(overrides: Partial<JobArg>): JobArg {
	return {
		job_type: "DEPLOY",
		project_id: null,
		environment_id: null,
		config_snapshot: {},
		...overrides,
	};
}

describe("stateKeyForJob", () => {
	it("keys project jobs by project/environment UUIDs", () => {
		const r = stateKeyForJob(
			job({ job_type: "DEPLOY", project_id: "p-1", environment_id: "e-1" }),
		);
		expect(r).toEqual({ key: projectStateKey("p-1", "e-1") });
	});

	// #838: placement-aware state keying — shared placements key on the Fabric, dedicated on the env.
	it("keys a dedicated placement by the environment (byte-identical to the pre-Fabric path)", () => {
		const r = stateKeyForJob(
			job({
				project_id: "p-1",
				environment_id: "e-1",
				config_snapshot: { placement_mode: "dedicated", fabric_id: FABRIC_UUID },
			}),
		);
		// The Fabric id is present but IGNORED for dedicated → still keyed on the environment.
		expect(r).toEqual({ key: projectStateKey("p-1", "e-1") });
	});

	it("keys by the environment when the snapshot predates the Fabric fields (no placement_mode)", () => {
		const r = stateKeyForJob(
			job({ project_id: "p-1", environment_id: "e-1", config_snapshot: {} }),
		);
		expect(r).toEqual({ key: projectStateKey("p-1", "e-1") });
	});

	it.each(["namespace", "vcluster"])(
		"keys a %s placement by its Fabric so co-Fabric environments share one state object",
		(placement_mode) => {
			const r = stateKeyForJob(
				job({
					project_id: "p-1",
					environment_id: "e-1",
					config_snapshot: { placement_mode, fabric_id: FABRIC_UUID },
				}),
			);
			expect(r).toEqual({ key: projectStateKey("p-1", FABRIC_UUID) });
		},
	);

	it("400s a shared placement missing its fabric_id", () => {
		const r = stateKeyForJob(
			job({
				project_id: "p-1",
				environment_id: "e-1",
				config_snapshot: { placement_mode: "namespace" },
			}),
		);
		expect("error" in r && r.status).toBe(400);
		expect("key" in r).toBe(false);
	});

	it("400s (no path injection) when a shared placement's fabric_id is not a canonical UUID", () => {
		const r = stateKeyForJob(
			job({
				project_id: "p-1",
				environment_id: "e-1",
				config_snapshot: {
					placement_mode: "vcluster",
					fabric_id: "../projects/victim/env/tofu.tfstate",
				},
			}),
		);
		expect("error" in r && r.status).toBe(400);
		expect("key" in r).toBe(false);
	});

	it("400s a project job with no project/environment", () => {
		const r = stateKeyForJob(job({ job_type: "PLAN" }));
		expect("error" in r && r.status).toBe(400);
	});

	it.each<ProvisionJobType>(["DEPLOY_RUNNER", "UPDATE_RUNNER", "DESTROY_RUNNER"])(
		"keys %s by the target runner UUID from config_snapshot",
		(job_type) => {
			const r = stateKeyForJob(
				job({ job_type, config_snapshot: { runner_id: RUNNER_UUID } }),
			);
			expect(r).toEqual({ key: runnerStateKey(RUNNER_UUID) });
		},
	);

	it("400s a runner-lifecycle job with a missing runner_id", () => {
		const r = stateKeyForJob(job({ job_type: "DEPLOY_RUNNER" }));
		expect("error" in r && r.status).toBe(400);
	});

	it("400s a runner-lifecycle job whose runner_id is not a canonical UUID", () => {
		const r = stateKeyForJob(
			job({ job_type: "DEPLOY_RUNNER", config_snapshot: { runner_id: "not-a-uuid" } }),
		);
		expect("error" in r && r.status).toBe(400);
	});

	it("400s (no path injection) when runner_id smuggles a traversal onto a project object", () => {
		const r = stateKeyForJob(
			job({
				job_type: "DESTROY_RUNNER",
				config_snapshot: { runner_id: "../projects/victim/env/tofu.tfstate" },
			}),
		);
		expect("error" in r && r.status).toBe(400);
		expect("key" in r).toBe(false);
	});

	it("400s when runner_id is a non-string", () => {
		const r = stateKeyForJob(
			job({ job_type: "UPDATE_RUNNER", config_snapshot: { runner_id: 42 } }),
		);
		expect("error" in r && r.status).toBe(400);
	});
});
