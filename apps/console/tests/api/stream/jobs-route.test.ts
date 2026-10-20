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
vi.mock("@/lib/realtime", () => ({
	getRealtimeTransport: () => ({ subscribe: () => () => {} }),
}));

import { getServiceDb } from "@/lib/db";

/**
 * A drizzle-ish chain: the job lookup ends in `.limit()` → `jobRows`; the log backlog fetch ends
 * in `.orderBy()` → `[]`. Both are thenable so `await` resolves them.
 */
function mockDb(jobRows: unknown[]) {
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: () => db,
		limit: () => Promise.resolve(jobRows),
		orderBy: () => Promise.resolve([]),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
}

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
