// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Pins the tenant guard on GET /api/stream/jobs/[id] (the console's SSE log stream). The guard
// reads via the service DB (RLS-bypassing), so it applies the jobs `owner_all` RLS predicate by
// hand: `org_id = current_org OR org_id = current_owner` — the job belongs to the active org or to
// the caller's personal org (whose id is the user's id). Two properties under test: a job stamped
// `org_id = user_id` by the `set_org_id` fallback still streams on a hosted org (orgId ≠ userId),
// and a job is reachable only from the org it belongs to — the predicate reads `org_id` alone.

import { beforeEach, describe, expect, it, vi } from "vitest";

const getOwner = vi.fn();
const getActiveScope = vi.fn();
const authorizeUserId = vi.fn();

vi.mock("@/lib/auth/owner", () => ({ getOwner: () => getOwner() }));
vi.mock("@/lib/auth/scope", () => ({ getActiveScope: (o: string) => getActiveScope(o) }));
vi.mock("@/lib/authz/guard", () => ({
	authorizeUserId: (...a: unknown[]) => authorizeUserId(...a),
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
const isJobVisible = vi.fn();
vi.mock("@/lib/jobs/visibility", () => ({ isJobVisible: (...a: unknown[]) => isJobVisible(...a) }));
vi.mock("@/lib/realtime", () => ({
	getRealtimeTransport: () => ({ subscribe: () => () => {} }),
}));

import { getServiceDb } from "@/lib/db";

/**
 * A drizzle-ish chain: every job lookup (the tenant guard's, then the stream's own status reads)
 * ends in `.limit()` → `jobRows`; each log fetch ends in `.orderBy()` → the next of `logFetches`,
 * and `[]` once they are spent. Both are thenable so `await` resolves them.
 */
function mockDb(jobRows: unknown[], logFetches: unknown[][] = []) {
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: () => db,
		limit: () => Promise.resolve(jobRows),
		orderBy: () => Promise.resolve(logFetches.shift() ?? []),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
}

/** Opens the stream and reads its body to the end; resolves only if the route ends the stream itself. */
async function streamToEnd(jobId: string): Promise<string> {
	const { GET } = await import("@/app/api/stream/jobs/[id]/route");
	const res = await GET(new Request(`https://console.local/api/stream/jobs/${jobId}`), {
		params: Promise.resolve({ id: jobId }),
	});
	return res.text();
}

/** One log row as the stream reads it. */
const logRow = (id: number) => ({
	id,
	log_chunk: `line ${id}`,
	stream_type: "STDOUT",
	created_at: new Date("2026-10-20T10:00:00.000Z"),
});

async function stream(jobId: string) {
	const { GET } = await import("@/app/api/stream/jobs/[id]/route");
	const ctrl = new AbortController();
	const res = await GET(
		new Request(`https://console.local/api/stream/jobs/${jobId}`, {
			signal: ctrl.signal,
		}),
		{ params: Promise.resolve({ id: jobId }) },
	);
	// Tear the stream down (clears the heartbeat interval + realtime subscription).
	ctrl.abort();
	return res;
}

beforeEach(() => {
	vi.clearAllMocks();
	getOwner.mockResolvedValue("user-1");
	authorizeUserId.mockResolvedValue(null); // authorized
	getActiveScope.mockResolvedValue({ userId: "user-1", orgId: "org-1" });
	isJobVisible.mockResolvedValue(true);
});

describe("GET /api/stream/jobs/[id] tenant guard", () => {
	it("401s when unauthenticated", async () => {
		getOwner.mockResolvedValue(null);
		expect((await stream("job-1")).status).toBe(401);
	});

	it("propagates the authz denial (forbidden)", async () => {
		authorizeUserId.mockResolvedValue(new Response("forbidden", { status: 403 }));
		expect((await stream("job-1")).status).toBe(403);
	});

	it("404s when the job doesn't exist", async () => {
		mockDb([]);
		expect((await stream("missing")).status).toBe(404);
	});

	it("404s when neither the owner nor the org matches", async () => {
		mockDb([{ org_id: "org-other", user_id: "user-other" }]);
		expect((await stream("job-1")).status).toBe(404);
	});

	it("streams a job whose org_id defaulted to the caller's user id on a hosted org", async () => {
		// user_id matches the caller; org_id (= the trigger's user_id default) ≠ the active org.
		mockDb([{ org_id: "user-1", user_id: "user-1" }]);
		const res = await stream("job-1");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/event-stream");
	});

	it("a job outside the addressed organization is not found", async () => {
		// The predicate reads the job's org alone; `user_id` plays no part in it.
		mockDb([{ org_id: "org-other", user_id: "user-1" }]);
		expect((await stream("job-1")).status).toBe(404);
	});

	it("streams a job of the caller's personal org from a hosted org scope", async () => {
		// org_id = the caller's personal org (= their user id), created by the system on their behalf.
		mockDb([{ org_id: "user-1", user_id: "someone-else" }]);
		expect((await stream("job-1")).status).toBe(200);
	});

	it("404s for a job with no org", async () => {
		mockDb([{ org_id: null, user_id: "user-1" }]);
		expect((await stream("job-1")).status).toBe(404);
	});

	it("streams an org-scoped job the caller doesn't personally own (teammate view)", async () => {
		mockDb([{ org_id: "org-1", user_id: "user-creator" }]);
		expect((await stream("job-1")).status).toBe(200);
	});
});

describe("GET /api/stream/jobs/[id] — job visibility follows project visibility", () => {
	it("404s a job of a project the reader may not view, as if it did not exist", async () => {
		mockDb([{ org_id: "org-1", project_id: "proj-denied" }]);
		isJobVisible.mockResolvedValue(false);
		expect((await stream("job-1")).status).toBe(404);
		expect(isJobVisible).toHaveBeenCalledWith(
			{ userId: "user-1", orgId: "org-1" },
			expect.objectContaining({ project_id: "proj-denied" }),
		);
	});

	it("streams a job of a project the reader may view", async () => {
		mockDb([{ org_id: "org-1", project_id: "proj-ok" }]);
		expect((await stream("job-1")).status).toBe(200);
		expect(isJobVisible).toHaveBeenCalledWith(
			{ userId: "user-1", orgId: "org-1" },
			expect.objectContaining({ project_id: "proj-ok" }),
		);
	});

	it("asks nothing of a job outside the reader's tenancy — that is a 404 already", async () => {
		mockDb([{ org_id: "org-other", project_id: "proj-x" }]);
		expect((await stream("job-1")).status).toBe(404);
		expect(isJobVisible).not.toHaveBeenCalled();
	});
});

// #6818 (D-15): a finished job's stream is its remaining lines and then an end, not a connection
// held open for ever. The reader stops on the `end` event and does not reconnect.
describe("GET /api/stream/jobs/[id] — the stream ends when the job has", () => {
	/** A job that finished long before the settle window: nothing can still be on its way. */
	const FINISHED = { org_id: "org-1", status: "SUCCESS", completed_at: new Date("2026-01-01T00:00:00.000Z") };

	it("sends a finished job's lines, then the end event, and closes", async () => {
		mockDb([FINISHED], [[logRow(1), logRow(2)]]);
		const body = await streamToEnd("job-1");
		expect(body).toBe(
			[
				`id: 1\ndata: ${JSON.stringify(logRow(1))}\n\n`,
				`id: 2\ndata: ${JSON.stringify(logRow(2))}\n\n`,
				"event: end\ndata: {}\n\n",
			].join(""),
		);
	});

	it("the end event carries no id, so a reader's resume point stays on the last line", async () => {
		mockDb([FINISHED], [[logRow(7)]]);
		const body = await streamToEnd("job-1");
		const endFrame = body.slice(body.indexOf("event: end"));
		expect(endFrame).not.toContain("id:");
	});

	it("a finished job with no lines left is the end event alone", async () => {
		mockDb([{ ...FINISHED, status: "CANCELLED" }]);
		expect(await streamToEnd("job-1")).toBe("event: end\ndata: {}\n\n");
	});

	it("a job that has only just finished is read once more after the settle window, then ended", async () => {
		const { GET } = await import("@/app/api/stream/jobs/[id]/route");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		try {
			// Finished one second ago: its runner may still be shipping its last buffer. The wait
			// is the settle window (five seconds) less the second already gone.
			mockDb(
				[{ org_id: "org-1", status: "FAILED", completed_at: new Date(Date.now() - 1_000) }],
				[[logRow(1)], [logRow(2)]],
			);
			const res = await GET(new Request("https://console.local/api/stream/jobs/job-1"), {
				params: Promise.resolve({ id: "job-1" }),
			});
			const reading = res.text();
			let settled = false;
			void reading.then(() => {
				settled = true;
			});
			// Let the first pass run up to its wait.
			for (let i = 0; i < 50 && vi.getTimerCount() === 0; i += 1) await vi.advanceTimersByTimeAsync(0);
			expect(vi.getTimerCount()).toBe(1);

			await vi.advanceTimersByTimeAsync(3_000);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1_000);
			// The line that arrived during the wait is in the stream, before the end.
			expect(await reading).toBe(
				[
					`id: 1\ndata: ${JSON.stringify(logRow(1))}\n\n`,
					`id: 2\ndata: ${JSON.stringify(logRow(2))}\n\n`,
					"event: end\ndata: {}\n\n",
				].join(""),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a running job's stream stays open: its backlog is sent and no end event follows", async () => {
		mockDb([{ org_id: "org-1", status: "PROCESSING", completed_at: null }], [[logRow(1)]]);
		const { GET } = await import("@/app/api/stream/jobs/[id]/route");
		const ctrl = new AbortController();
		const res = await GET(new Request("https://console.local/api/stream/jobs/job-1", { signal: ctrl.signal }), {
			params: Promise.resolve({ id: "job-1" }),
		});
		const reader = res.body?.getReader();
		const first = await reader?.read();
		expect(new TextDecoder().decode(first?.value)).toBe(`id: 1\ndata: ${JSON.stringify(logRow(1))}\n\n`);
		// Tear it down; the route closes the body for a client that has gone.
		ctrl.abort();
		const rest = await reader?.read();
		expect(rest?.done).toBe(true);
	});
});
