// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6445 — a runner is served only the config_snapshot keys it decodes. Against the fixtures the
// runner's own contract test (apps/runner/internal/agent/snapshot_capabilities_test.go) decodes: the
// strip turns `with-byo-marker.json` into exactly `without-byo-marker.json`, which a runner built
// before the marker decodes.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	RUNNER_CAPABILITY_ADDON_BYO_MARKER,
	ociByoAddOnIds,
	parseRunnerCapabilities,
	refusalForRunner,
	snapshotForRunner,
} from "@/lib/runners/snapshot-capabilities";

const FIXTURES = resolve(__dirname, "../../../../../packages/core/types/testdata/snapshot-capabilities");

/** One shared fixture, as the open record a stored snapshot is. */
function fixture(name: string): Record<string, unknown> {
	return z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8")));
}

describe("snapshotForRunner", () => {
	it("serves a runner without the capability the snapshot an old runner decodes", () => {
		expect(snapshotForRunner(fixture("with-byo-marker.json"), parseRunnerCapabilities(null))).toEqual(
			fixture("without-byo-marker.json"),
		);
	});

	it("serves a runner with the capability the snapshot unchanged", () => {
		const snapshot = fixture("with-byo-marker.json");
		const caps = parseRunnerCapabilities(` other , ${RUNNER_CAPABILITY_ADDON_BYO_MARKER}`);
		expect(snapshotForRunner(snapshot, caps)).toBe(snapshot);
	});

	it("never mutates the stored snapshot", () => {
		const snapshot = fixture("with-byo-marker.json");
		const before = JSON.stringify(snapshot);
		snapshotForRunner(snapshot, parseRunnerCapabilities(""));
		expect(JSON.stringify(snapshot)).toBe(before);
	});

	it("leaves a snapshot with no marker — and one with no add-ons — as it is", () => {
		const without = fixture("without-byo-marker.json");
		expect(snapshotForRunner(without, parseRunnerCapabilities(null))).toBe(without);
		const runnerJob = { runner_id: "r1" };
		expect(snapshotForRunner(runnerJob, parseRunnerCapabilities(null))).toBe(runnerJob);
	});

	it("matches the runner's capability name exactly", () => {
		expect(RUNNER_CAPABILITY_ADDON_BYO_MARKER).toBe("addon-byo-marker");
		expect(parseRunnerCapabilities("addon-byo-marker-v2").has(RUNNER_CAPABILITY_ADDON_BYO_MARKER)).toBe(false);
	});
});

describe("refusalForRunner", () => {
	const none = parseRunnerCapabilities(null);
	const capable = parseRunnerCapabilities(RUNNER_CAPABILITY_ADDON_BYO_MARKER);

	it("finds exactly the OCI BYO charts: marked, not git", () => {
		expect(ociByoAddOnIds(fixture("with-byo-marker.json"))).toEqual(["payments"]);
		expect(ociByoAddOnIds(fixture("without-byo-marker.json"))).toEqual([]);
	});

	it("refuses a DEPLOY with an OCI BYO chart to a runner without the capability, naming the chart and the fix", () => {
		expect(refusalForRunner("DEPLOY", fixture("with-byo-marker.json"), none)).toMatch(
			/OCI chart \(“payments”\), which needs a runner newer than runner-v0\.8\.0.*Update the runner/,
		);
	});

	it("serves it to a capable runner, and serves other job types and git-only snapshots to any runner", () => {
		expect(refusalForRunner("DEPLOY", fixture("with-byo-marker.json"), capable)).toBeNull();
		expect(refusalForRunner("PLAN", fixture("with-byo-marker.json"), none)).toBeNull();
		expect(refusalForRunner("DESTROY", fixture("with-byo-marker.json"), none)).toBeNull();
		const gitOnly = {
			addons: [{ id: "api", source: "git", byo: true }, { id: "reloader" }],
		};
		expect(refusalForRunner("DEPLOY", gitOnly, none)).toBeNull();
	});
});
