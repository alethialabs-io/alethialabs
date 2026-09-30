// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// finalizeChartScan — the job-status route's service-role write-back of a CHART_SCAN result onto its
// BYO chart row, plus the dark-launched DESCRIBE reconcile of the workloads the chart renders.
// Mocked boundary: the service DB is a recording chain whose SELECTs resolve scripted rows in call
// order (the job, then the chart addon).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
	/** Rows each awaited SELECT resolves to, consumed in call order. */
	const selects: unknown[][] = [];
	/** Every write the code under test made, in order. */
	const writes: { op: "update" | "insert" | "delete"; table: unknown; payload: unknown }[] = [];

	/** A drizzle-shaped SELECT builder: every step returns itself; awaiting it resolves the next rows. */
	class Chain implements PromiseLike<unknown[]> {
		/** Builder step (no-op). */
		select(): this {
			return this;
		}
		/** Builder step (no-op). */
		from(): this {
			return this;
		}
		/** Builder step (no-op). */
		where(): this {
			return this;
		}
		/** Builder step (no-op). */
		limit(): this {
			return this;
		}
		/** Resolves the next scripted rows. */
		then<A = unknown[], B = never>(
			onFulfilled?: ((rows: unknown[]) => A | PromiseLike<A>) | null,
			onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
		): PromiseLike<A | B> {
			return Promise.resolve(selects.shift() ?? []).then(onFulfilled, onRejected);
		}
	}

	const done = { where: (): Promise<void> => Promise.resolve() };
	const db = {
		/** Starts a scripted SELECT. */
		select: () => new Chain(),
		/** Records an UPDATE's set payload. */
		update(table: unknown) {
			return {
				/** Records the payload. */
				set(payload: unknown) {
					writes.push({ op: "update", table, payload });
					return done;
				},
			};
		},
		/** Records an upsert's row. */
		insert(table: unknown) {
			return {
				/** Records the row. */
				values(payload: unknown) {
					writes.push({ op: "insert", table, payload });
					return { onConflictDoUpdate: (): Promise<void> => Promise.resolve() };
				},
			};
		},
		/** Records a DELETE. */
		delete(table: unknown) {
			writes.push({ op: "delete", table, payload: null });
			return done;
		},
	};
	return { db, selects, writes };
});

vi.mock("@/lib/db", () => ({ getServiceDb: () => fake.db }));

import { finalizeChartScan } from "@/lib/addons/chart-scan-finalize";
import { projectAddons, projectChartWorkloads } from "@/lib/db/schema";

const OLD_FLAG = process.env.ALETHIA_BYO_DESCRIBE_ENABLED;

/** A finished CHART_SCAN job row, with overrides. */
function scanJob(over: Record<string, unknown> = {}) {
	return {
		id: "job-1",
		job_type: "CHART_SCAN",
		status: "SUCCESS",
		config_snapshot: { project_id: "p1", environment_id: "env-1", addon_id: "byo-redis" },
		execution_metadata: { verify_result: { ok: true, findings: [] } },
		...over,
	};
}

const WORKLOAD = {
	name: "redis-master",
	workload_kind: "statefulset",
	rendered: { image: "redis:7", ports: [], env_keys: [], replicas: 1 },
};

beforeEach(() => {
	fake.selects.length = 0;
	fake.writes.length = 0;
	delete process.env.ALETHIA_BYO_DESCRIBE_ENABLED;
});

afterEach(() => {
	if (OLD_FLAG === undefined) delete process.env.ALETHIA_BYO_DESCRIBE_ENABLED;
	else process.env.ALETHIA_BYO_DESCRIBE_ENABLED = OLD_FLAG;
	vi.restoreAllMocks();
});

describe("finalizeChartScan — the scan write-back", () => {
	it("marks a clean scan done with its report", async () => {
		fake.selects.push([scanJob()]);
		await finalizeChartScan("job-1");
		expect(fake.writes).toHaveLength(1);
		expect(fake.writes[0]).toMatchObject({
			op: "update",
			table: projectAddons,
			payload: { scan_status: "done", scan_report: { ok: true, findings: [] } },
		});
	});

	it("marks a failed job failed", async () => {
		fake.selects.push([scanJob({ status: "FAILED" })]);
		await finalizeChartScan("job-1");
		expect(fake.writes[0].payload).toMatchObject({ scan_status: "failed" });
	});

	it("marks a SUCCESS with no report failed (fail closed)", async () => {
		fake.selects.push([scanJob({ execution_metadata: null })]);
		await finalizeChartScan("job-1");
		expect(fake.writes[0].payload).toMatchObject({ scan_status: "failed", scan_report: null });
	});

	it.each([
		["the job does not exist", []],
		["it is not a CHART_SCAN", [scanJob({ job_type: "IAC_SCAN" })]],
		["the snapshot lost the row identity", [scanJob({ config_snapshot: { project_id: "p1" } })]],
		["the snapshot is empty", [scanJob({ config_snapshot: null })]],
	])("writes nothing when %s", async (_why, rows) => {
		fake.selects.push(rows);
		await finalizeChartScan("job-1");
		expect(fake.writes).toEqual([]);
	});
});

describe("finalizeChartScan — DESCRIBE (ALETHIA_BYO_DESCRIBE_ENABLED)", () => {
	it("does not describe while the flag is off", async () => {
		fake.selects.push([scanJob({ execution_metadata: { verify_result: {}, chart_workloads: [WORKLOAD] } })]);
		await finalizeChartScan("job-1");
		expect(fake.writes.map((w) => w.op)).toEqual(["update"]);
	});

	it("upserts each rendered workload with inferred value paths, then prunes the rest", async () => {
		process.env.ALETHIA_BYO_DESCRIBE_ENABLED = "true";
		fake.selects.push(
			[scanJob({ execution_metadata: { verify_result: {}, chart_workloads: [WORKLOAD] } })],
			[{ id: "addon-uuid" }],
		);
		await finalizeChartScan("job-1");
		expect(fake.writes.map((w) => w.op)).toEqual(["update", "insert", "delete"]);
		expect(fake.writes[1]).toMatchObject({
			table: projectChartWorkloads,
			payload: {
				project_id: "p1",
				environment_id: "env-1",
				addon_id: "addon-uuid",
				name: "redis-master",
				workload_kind: "statefulset",
				value_paths: { replicas: "replicaCount", env: "extraEnvVars" },
			},
		});
		expect(fake.writes[2].table).toBe(projectChartWorkloads);
	});

	it("prunes every workload when the chart now renders none", async () => {
		process.env.ALETHIA_BYO_DESCRIBE_ENABLED = "true";
		fake.selects.push([scanJob({ execution_metadata: { verify_result: {} } })], [{ id: "addon-uuid" }]);
		await finalizeChartScan("job-1");
		expect(fake.writes.map((w) => w.op)).toEqual(["update", "delete"]);
	});

	it("skips the reconcile when the chart row is gone", async () => {
		process.env.ALETHIA_BYO_DESCRIBE_ENABLED = "true";
		fake.selects.push([scanJob({ execution_metadata: { verify_result: {}, chart_workloads: [WORKLOAD] } })], []);
		await finalizeChartScan("job-1");
		expect(fake.writes.map((w) => w.op)).toEqual(["update"]);
	});

	it("refuses an invalid workloads wire without writing any workload", async () => {
		process.env.ALETHIA_BYO_DESCRIBE_ENABLED = "true";
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		fake.selects.push([scanJob({ execution_metadata: { verify_result: {}, chart_workloads: [{ name: "" }] } })]);
		await finalizeChartScan("job-1");
		expect(fake.writes.map((w) => w.op)).toEqual(["update"]);
		expect(error).toHaveBeenCalled();
	});
});
