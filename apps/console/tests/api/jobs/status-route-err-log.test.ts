// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// PUT /api/jobs/[id]/status logs a caught error through the logger's `err` serializer
// (lib/observability/log.ts), on both of its best-effort paths: a receipt anchoring that throws, and
// a state-lock release that fails. The error is passed under `err` as the error itself, not as
// `String(err)` — a string skips the serializer, so it writes the error's whole text unexamined.
// The logger here is the real one, writing to a captured stream, so the assertions read the line.

import { DrizzleQueryError } from "drizzle-orm/errors";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Every JSON line the route's logger wrote, parsed. */
const lines = vi.hoisted((): unknown[] => []);

vi.mock("@/lib/observability/log", async () => {
	const actual = await vi.importActual<typeof import("@/lib/observability/log")>(
		"@/lib/observability/log",
	);
	const destination = {
		/** Parses each newline-delimited JSON line pino writes into `lines`. */
		write(chunk: string) {
			for (const line of chunk.split("\n")) {
				if (line.trim()) {
					const parsed: unknown = JSON.parse(line);
					lines.push(parsed);
				}
			}
		},
	};
	return { ...actual, log: actual.createLogger({ level: "debug", destination }) };
});

const verifyRunnerToken = vi.fn();
vi.mock("@/lib/runners/auth", () => ({
	verifyRunnerToken: (req: Request) => verifyRunnerToken(req),
}));

/** The job row the route re-selects after the status RPC. */
const job = {
	job_type: "DEPLOY",
	project_id: "proj-1",
	environment_id: null,
	org_id: "org-1",
	user_id: "user-1",
	cloud_identity_id: null,
	execution_metadata: null,
	provider: "aws",
	traceparent: null,
	created_at: new Date(),
	claimed_at: new Date(),
};

/** A drizzle-ish stub: the status RPC applies, and the select chain returns `job`. */
const db: Record<string, unknown> = {};
Object.assign(db, {
	_: { schema: {}, fullSchema: {} },
	execute: () => Promise.resolve([{ applied: true }]),
	select: () => db,
	from: () => db,
	where: () => db,
	limit: () => Promise.resolve([job]),
});
vi.mock("@/lib/db", () => ({ getServiceDb: () => db }));

vi.mock("@/lib/alerts/emit", () => ({ emitAlertEventSafe: vi.fn() }));
vi.mock("@/lib/billing/meter", () => ({
	reportJobUsageOnce: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/analytics/server", () => ({ captureServer: vi.fn() }));
vi.mock("@/lib/jobs/job-failed", () => ({
	recordJobFailed: vi.fn().mockResolvedValue(undefined),
}));

const anchorReceipt = vi.fn();
vi.mock("@/lib/evidence/receipt-anchor", () => ({
	anchorReceipt: (...a: unknown[]) => anchorReceipt(...a),
}));
const releaseStateLocksForJob = vi.fn();
vi.mock("@/lib/runners/state-lock", () => ({
	releaseStateLocksForJob: (...a: unknown[]) => releaseStateLocksForJob(...a),
}));

/** A multi-line SQL text, as drizzle builds for a longer query. */
const SQL = 'select "id"\nfrom "users"\nwhere "email" = $1';
/** The bound parameter values of the failed query. */
const PARAMS = ["a@b.c"];
/** A value planted on the error as an enumerable field; the serializer never writes it. */
const PLANTED = "planted-enumerable-field-value";

/** Builds a real drizzle-orm query error, caused by a driver error, with a planted field. */
function queryError(): DrizzleQueryError {
	const cause = Object.assign(new Error("duplicate key value violates unique constraint"), {
		code: "23505",
	});
	return Object.assign(new DrizzleQueryError(SQL, PARAMS, cause), { connection: PLANTED });
}

/** Returns the one captured line whose `msg` is `msg`, failing the test when there is none. */
function lineWithMsg(msg: string): unknown {
	const found = lines.find(
		(l) => typeof l === "object" && l !== null && "msg" in l && l.msg === msg,
	);
	if (found === undefined) throw new Error(`no log line "${msg}"`);
	return found;
}

/**
 * Asserts the line's `err` is the query error as the serializer writes it: an object with its type
 * and its cause's code, and without the planted enumerable field.
 */
function expectSerializedQueryError(line: unknown): void {
	expect(JSON.stringify(line)).not.toContain(PLANTED);
	expect(line).toMatchObject({
		err: { type: "DrizzleQueryError", cause: { code: "23505" } },
	});
}

beforeAll(async () => {
	// Warm the route's large module graph outside any test's timeout budget.
	await import("@/app/api/jobs/[id]/status/route");
}, 60_000);

/** Invokes the PUT route with a JSON body. */
async function put(jobId: string, body: unknown) {
	const { PUT } = await import("@/app/api/jobs/[id]/status/route");
	return PUT(
		new Request(`https://console.local/api/jobs/${jobId}/status`, {
			method: "PUT",
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ id: jobId }) },
	);
}

beforeEach(() => {
	lines.length = 0;
	vi.clearAllMocks();
	verifyRunnerToken.mockResolvedValue({
		runnerId: "11111111-1111-1111-1111-111111111111",
		tokenHash: "h",
		error: null,
	});
	anchorReceipt.mockResolvedValue(null);
	releaseStateLocksForJob.mockResolvedValue(0);
});

describe("PUT /api/jobs/[id]/status — a caught error is logged through the err serializer", () => {
	it("writes a failed state-lock release's error as the serializer writes it", async () => {
		releaseStateLocksForJob.mockRejectedValue(queryError());
		const res = await put("job-1", { status: "SUCCESS" });
		expect(res.status).toBe(200);
		expectSerializedQueryError(lineWithMsg("failed to release state locks for terminal job"));
	});

	it("writes a throwing receipt anchoring's error as the serializer writes it", async () => {
		anchorReceipt.mockRejectedValue(queryError());
		const res = await put("job-1", {
			status: "SUCCESS",
			execution_metadata: { verify_receipt: { digest: "sha256:abc" } },
		});
		expect(res.status).toBe(200);
		expectSerializedQueryError(lineWithMsg("rekor anchoring threw unexpectedly (fail-open)"));
	});
});
