// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE ONE CANCEL (#6121, lib/jobs/cancel.ts) the console and the CLI share. Over a stubbed database
// and PDP: the read goes through the caller's predicate, the target's permission is enforced before
// anything is written, the flip is conditional on a cancellable status and stamps completed_at, a
// job that finished between the read and the write is NOT rewritten, and the runner is signalled
// from what the flip actually changed — not from the status read before it.

import { is, SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const enforce = vi.fn();
vi.mock("@/lib/authz", () => ({ getPdp: () => ({ enforce }) }));
const notifyRunnerCancel = vi.fn(async (_runnerId: string, _jobId: string) => undefined);
vi.mock("@/lib/runners/cancel-signal", () => ({
	notifyRunnerCancel: (runnerId: string, jobId: string) => notifyRunnerCancel(runnerId, jobId),
}));

import { ForbiddenError } from "@/lib/authz/types";
import { cancelJobAs } from "@/lib/jobs/cancel";

const ACTOR = { userId: "u-1", orgId: "o-1" };
const JOB = "job-1";
const dialect = new PgDialect();
const SCOPE = sql.raw("caller_scope");

/** A fake database: reads answer `reads` in order, the update answers `flipped`; records writes. */
function fakeDb(reads: unknown[][], flipped: unknown[]) {
	const writes: { set: unknown; where: unknown }[] = [];
	const readWheres: unknown[] = [];
	let r = 0;
	const tx = {
		select: () => ({
			from: () => ({
				where: (w: unknown) => {
					readWheres.push(w);
					return { limit: async () => reads[r++] ?? [] };
				},
			}),
		}),
		update: () => ({
			set: (set: unknown) => ({
				where: (where: unknown) => ({
					returning: async () => {
						writes.push({ set, where });
						return flipped;
					},
				}),
			}),
		}),
	};
	// The real `run` hands a transaction; the fake hands the stub, which is all the code touches.
	const run = <T,>(work: (t: never) => Promise<T>) => work(tx as never);
	return { run, writes, readWheres };
}

/** The SQL text of a recorded predicate. */
const text = (w: unknown) => (is(w, SQL) ? dialect.sqlToQuery(w).sql : "");

beforeEach(() => {
	enforce.mockReset();
	notifyRunnerCancel.mockClear();
});

describe("cancelJobAs", () => {
	it("reads through the caller's scope and answers not-found when the job is outside it", async () => {
		const db = fakeDb([[]], []);
		expect(await cancelJobAs(ACTOR, JOB, SCOPE, db.run)).toEqual({ kind: "not-found" });
		expect(text(db.readWheres[0])).toContain("caller_scope");
		expect(db.writes).toEqual([]);
	});

	it("enforces the project operation's permission before writing", async () => {
		const db = fakeDb([[{ status: "QUEUED", job_type: "DEPLOY", project_id: "p-1", environment_id: "e-1", config_snapshot: {} }]], [{ runner_id: null }]);
		await cancelJobAs(ACTOR, JOB, SCOPE, db.run);
		expect(enforce).toHaveBeenCalledWith(ACTOR, "deploy", { type: "project", id: "p-1" });
	});

	it("a runner's lifecycle job takes the runner's permission, not the org's job permission", async () => {
		const db = fakeDb([[{ status: "QUEUED", job_type: "DESTROY_RUNNER", project_id: null, environment_id: null, config_snapshot: { runner_id: "r-1" } }]], [{ runner_id: null }]);
		await cancelJobAs(ACTOR, JOB, SCOPE, db.run);
		expect(enforce).toHaveBeenCalledWith(ACTOR, "destroy", { type: "runner", id: "r-1" });
	});

	it("a runner job whose runner cannot be named is not cancelled under the org permission alone", async () => {
		const db = fakeDb([[{ status: "QUEUED", job_type: "UPDATE_RUNNER", project_id: null, environment_id: null, config_snapshot: {} }]], [{ runner_id: null }]);
		expect(await cancelJobAs(ACTOR, JOB, SCOPE, db.run)).toEqual({ kind: "no-target" });
		expect(db.writes).toEqual([]);
	});

	it("a refused permission writes nothing", async () => {
		enforce.mockRejectedValueOnce(new ForbiddenError("deploy", { type: "project", id: "p-1" }));
		const db = fakeDb([[{ status: "QUEUED", job_type: "DEPLOY", project_id: "p-1", environment_id: "e-1", config_snapshot: {} }]], [{ runner_id: null }]);
		await expect(cancelJobAs(ACTOR, JOB, SCOPE, db.run)).rejects.toBeInstanceOf(ForbiddenError);
		expect(db.writes).toEqual([]);
	});

	it("flips only from a cancellable status, inside the caller's scope, and stamps completed_at", async () => {
		const db = fakeDb([[{ status: "QUEUED", job_type: "AUDIT", project_id: null, environment_id: null, config_snapshot: {} }]], [{ runner_id: null }]);
		expect(await cancelJobAs(ACTOR, JOB, SCOPE, db.run)).toEqual({ kind: "cancelled", signalled: false });
		const [write] = db.writes;
		expect(write?.set).toMatchObject({ status: "CANCELLED", error_message: "Cancelled by user", completed_at: expect.any(Date) });
		expect(text(write?.where)).toContain('"jobs"."status" in');
		expect(text(write?.where)).toContain("caller_scope");
	});

	it("THE RACE: a job that finished between the read and the write is not rewritten, and nothing is signalled", async () => {
		// Read as PROCESSING on a runner; by the write it is SUCCESS, so the conditional flip matches nothing.
		const db = fakeDb(
			[
				[{ status: "PROCESSING", job_type: "AUDIT", project_id: null, environment_id: null, config_snapshot: {} }],
				[{ status: "SUCCESS" }],
			],
			[],
		);
		expect(await cancelJobAs(ACTOR, JOB, SCOPE, db.run)).toEqual({ kind: "not-cancellable", status: "SUCCESS" });
		expect(notifyRunnerCancel).not.toHaveBeenCalled();
	});

	it("THE OTHER RACE: a job read as QUEUED but claimed before the flip IS signalled — from what the flip changed", async () => {
		const db = fakeDb([[{ status: "QUEUED", job_type: "AUDIT", project_id: null, environment_id: null, config_snapshot: {} }]], [{ runner_id: "runner-7" }]);
		expect(await cancelJobAs(ACTOR, JOB, SCOPE, db.run)).toEqual({ kind: "cancelled", signalled: true });
		expect(notifyRunnerCancel).toHaveBeenCalledWith("runner-7", JOB);
	});

	it("a failed signal never fails the cancel", async () => {
		notifyRunnerCancel.mockRejectedValueOnce(new Error("unreachable"));
		const db = fakeDb([[{ status: "PROCESSING", job_type: "AUDIT", project_id: null, environment_id: null, config_snapshot: {} }]], [{ runner_id: "runner-7" }]);
		expect(await cancelJobAs(ACTOR, JOB, SCOPE, db.run)).toEqual({ kind: "cancelled", signalled: true });
	});
});
