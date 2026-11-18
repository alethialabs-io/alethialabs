// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #6736: a missing cluster is SAID once per finding, and nothing changes by itself.
//
// The rule has two gates (lib/clusters/missing.ts): the TRANSITION — the observation read before the
// reading landed must not already be `missing` — and the ROW — the activity log must not already hold
// the same environment with the same evidence sentence. These tests pin both, the order (the row is
// written before the alert is raised), the teardown exemption, and that no status is ever written.

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	/** Results the stub's `limit()` answers, in call order: the env read, then the dedupe read. */
	limits: [] as unknown[][],
	update: vi.fn(),
	readClusterEvidence: vi.fn(),
	recordSystemActivity: vi.fn(),
	emitAlertEventSafe: vi.fn(),
}));

vi.mock("@/lib/db", () => {
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		innerJoin: () => db,
		where: () => db,
		limit: () => Promise.resolve(m.limits.shift() ?? []),
		update: m.update,
	});
	return { getServiceDb: () => db };
});
vi.mock("@/lib/clusters/observed-evidence", () => ({ readClusterEvidence: m.readClusterEvidence }));
vi.mock("@/lib/authz/activity", () => ({ recordSystemActivity: m.recordSystemActivity }));
vi.mock("@/lib/alerts/emit", () => ({ emitAlertEventSafe: m.emitAlertEventSafe }));

import {
	CLUSTER_MISSING_EVENT,
	notifyIfClusterNewlyMissing,
	observationBeforeReading,
} from "@/lib/clusters/missing";
import {
	type ControlPlaneObservation,
	missingEvidence,
	newlyMissing,
} from "@/lib/clusters/observed-state";

const ORG = "org-1";
const ENV = "env-1";
const DEPLOYED = new Date("2026-07-16T12:00:00.000Z");
const SCANNED = "2026-11-09T00:00:00.000Z";

const REPORTED: ControlPlaneObservation = { kind: "reported", observedAt: DEPLOYED.toISOString(), source: "deploy", fresh: false };
const MISSING: ControlPlaneObservation = {
	kind: "missing",
	source: "drift",
	observedAt: SCANNED,
	deleted: ["azurerm_resource_group.main"],
};

/** The environment row the notifier reads after the scan landed. */
function envRow(status = "ACTIVE") {
	return {
		id: ENV,
		name: "production",
		stage: "production",
		status,
		last_deployed_at: DEPLOYED,
		project_id: "proj-1",
		project_name: "shop",
	};
}

/** The evidence the drift scan just recorded: the resource group holding the cluster, deleted. */
function scanFoundDeleted() {
	m.readClusterEvidence.mockResolvedValue({
		drift: new Map([
			[ENV, { scannedAt: SCANNED, details: [{ address: "azurerm_resource_group.main", type: "azurerm_resource_group", kind: "deleted" }] }],
		]),
		probes: new Map(),
	});
}

/** Runs the notifier as the status route does after a DETECT_DRIFT scan landed. */
function notify(before: ControlPlaneObservation | null) {
	return notifyIfClusterNewlyMissing({ orgId: ORG, environmentId: ENV, before, jobId: "job-1", jobType: "DETECT_DRIFT" });
}

beforeEach(() => {
	vi.clearAllMocks();
	m.limits = [];
	m.recordSystemActivity.mockResolvedValue(undefined);
	scanFoundDeleted();
});

describe("newlyMissing — the transition gate", () => {
	it("is the finding when the observation turns missing", () => {
		expect(newlyMissing(REPORTED, MISSING)).toEqual(MISSING);
		expect(newlyMissing({ kind: "unreachable", observedAt: SCANNED, message: null }, MISSING)).toEqual(MISSING);
	});

	it("is null when it was already missing — a later scan finding it still gone is the same finding", () => {
		expect(newlyMissing(MISSING, { ...MISSING, observedAt: "2026-11-10T00:00:00.000Z" })).toBeNull();
	});

	it("is null when the observation is not missing", () => {
		expect(newlyMissing(REPORTED, REPORTED)).toBeNull();
		expect(newlyMissing(MISSING, REPORTED)).toBeNull();
	});
});

describe("missingEvidence — the finding's sentence", () => {
	it("names the reading, its own stamp and what it found deleted", () => {
		expect(missingEvidence(MISSING)).toBe(`Drift scan at ${SCANNED} found deleted: azurerm_resource_group.main`);
		expect(missingEvidence({ kind: "missing", source: "probe", observedAt: SCANNED, deleted: [] })).toBe(
			`Probe at ${SCANNED}: the cloud reports the cluster not found`,
		);
	});
});

describe("notifyIfClusterNewlyMissing", () => {
	it("records ONE system activity row and raises ONE critical alert when a scan newly finds the cluster deleted", async () => {
		m.limits = [[envRow()], []];

		await expect(notify(REPORTED)).resolves.toBe(true);

		const reason = missingEvidence(MISSING);
		expect(m.recordSystemActivity).toHaveBeenCalledTimes(1);
		expect(m.recordSystemActivity).toHaveBeenCalledWith(
			ORG,
			"cluster_missing",
			{ type: "environment", id: ENV },
			{ reason, resourceName: "shop / production" },
		);
		expect(m.emitAlertEventSafe).toHaveBeenCalledTimes(1);
		expect(m.emitAlertEventSafe).toHaveBeenCalledWith(
			ORG,
			CLUSTER_MISSING_EVENT,
			expect.objectContaining({
				severity: "critical",
				resource_type: "environment",
				resource_id: ENV,
				project_id: "proj-1",
				reason,
			}),
		);
		// The record comes first: a failed write must never leave an alert with nothing behind it.
		expect(m.recordSystemActivity.mock.invocationCallOrder[0]).toBeLessThan(
			m.emitAlertEventSafe.mock.invocationCallOrder[0],
		);
	});

	it("stays quiet when the cluster was ALREADY missing before the scan (same finding)", async () => {
		m.limits = [[envRow()], []];
		await expect(notify(MISSING)).resolves.toBe(false);
		expect(m.recordSystemActivity).not.toHaveBeenCalled();
		expect(m.emitAlertEventSafe).not.toHaveBeenCalled();
	});

	it("stays quiet when the activity log already holds this environment's finding (a re-posted reading)", async () => {
		m.limits = [[envRow()], [{ id: 42 }]];
		await expect(notify(REPORTED)).resolves.toBe(false);
		expect(m.recordSystemActivity).not.toHaveBeenCalled();
		expect(m.emitAlertEventSafe).not.toHaveBeenCalled();
	});

	it("raises nothing when the record cannot be written", async () => {
		m.limits = [[envRow()], []];
		m.recordSystemActivity.mockRejectedValue(new Error("db down"));
		await expect(notify(REPORTED)).rejects.toThrow("db down");
		expect(m.emitAlertEventSafe).not.toHaveBeenCalled();
	});

	it("skips an environment being torn down: its cluster going away is what was asked for", async () => {
		for (const status of ["DESTROYING", "DESTROYED"]) {
			m.limits = [[envRow(status)], []];
			await expect(notify(REPORTED)).resolves.toBe(false);
		}
		expect(m.emitAlertEventSafe).not.toHaveBeenCalled();
	});

	it("notifies nothing without a baseline, and nothing for another org's environment", async () => {
		await expect(notify(null)).resolves.toBe(false);
		m.limits = [[]];
		await expect(notify(REPORTED)).resolves.toBe(false);
		expect(m.emitAlertEventSafe).not.toHaveBeenCalled();
	});

	it("never writes a status — it only says so", async () => {
		m.limits = [[envRow()], []];
		await notify(REPORTED);
		expect(m.update).not.toHaveBeenCalled();
	});
});

describe("observationBeforeReading", () => {
	it("is null rather than throwing when the read fails, so a status update never fails on it", async () => {
		m.readClusterEvidence.mockRejectedValue(new Error("boom"));
		m.limits = [[envRow()]];
		await expect(observationBeforeReading(ORG, ENV)).resolves.toBeNull();
		await expect(observationBeforeReading(null, ENV)).resolves.toBeNull();
	});

	it("is the environment's current observation", async () => {
		m.limits = [[envRow()]];
		await expect(observationBeforeReading(ORG, ENV)).resolves.toEqual(MISSING);
	});
});
