// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A job's log page for the MCP `get_job_logs` tool (lib/ai/mcp/job-logs.ts), over a stood-in
// transaction: the PDP's `view` on the job is asked first, a job the reader cannot see is refused
// not-found with no log read, and `settled` is true only once a finished job's log has had time to
// land.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ withScope: vi.fn() }));
vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/jobs/visibility", () => ({ jobVisibleTo: vi.fn() }));

import { JOB_LOG_SETTLE_MS } from "@/components/jobs/job-log-contract";
import { readJobLogPage } from "@/lib/ai/mcp/job-logs";
import { authorize } from "@/lib/authz/guard";
import { withScope } from "@/lib/db";
import { jobVisibleTo } from "@/lib/jobs/visibility";
import { txAnswering } from "./tx-stub";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const LINES = [
	{ id: 11, log_chunk: "planning" },
	{ id: 12, log_chunk: "done" },
];

/** Runs the scoped callback against a transaction answering `rowSets`. */
function scopeTo(...rowSets: unknown[][]) {
	const tx = txAnswering(...rowSets);
	vi.mocked(withScope).mockImplementation(
		// The stub cannot satisfy drizzle's PgTransaction type; the same shape addons-version.test.ts uses.
		((_scope: unknown, cb: (t: unknown) => unknown) => cb(tx)) as never,
	);
	return tx;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	vi.mocked(authorize).mockResolvedValue({ userId: "user-1", orgId: "org-1" } as never);
	vi.mocked(jobVisibleTo).mockResolvedValue({} as never);
});

describe("readJobLogPage", () => {
	it("asks the PDP for view on the job and reads in the reader's scope", async () => {
		scopeTo([{ status: "RUNNING", completed_at: null }], LINES);
		const page = await readJobLogPage("job-1", 10, 500);
		expect(authorize).toHaveBeenCalledWith("view", { type: "job", id: "job-1" });
		expect(withScope).toHaveBeenCalledWith({ ownerId: "user-1", orgId: "org-1" }, expect.any(Function));
		expect(page).toEqual({ lines: LINES, settled: false });
	});

	it("refuses not-found, reading no log, for a job the reader cannot see", async () => {
		const tx = scopeTo([]);
		await expect(readJobLogPage("job-x", 0, 500)).rejects.toMatchObject({ kind: "not-found" });
		expect(tx.select).toHaveBeenCalledTimes(1);
	});

	it("is not settled while a finished job's log may still be landing", async () => {
		scopeTo([{ status: "SUCCESS", completed_at: new Date(NOW - JOB_LOG_SETTLE_MS) }], []);
		expect((await readJobLogPage("job-1", 0, 500)).settled).toBe(false);
	});

	it("is settled once a finished job has been done for twice the settle window", async () => {
		scopeTo([{ status: "FAILED", completed_at: new Date(NOW - 2 * JOB_LOG_SETTLE_MS - 1) }], LINES);
		expect(await readJobLogPage("job-1", 0, 500)).toEqual({ lines: LINES, settled: true });
	});

	it("is not settled for a finished job with no completion time", async () => {
		scopeTo([{ status: "CANCELLED", completed_at: null }], []);
		expect((await readJobLogPage("job-1", 0, 500)).settled).toBe(false);
	});
});
