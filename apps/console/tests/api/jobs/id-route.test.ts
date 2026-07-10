// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Pins the cross-tenant guard on GET /api/jobs/[id]: a valid runner token must NOT be
// able to read a job it does not own (previously any runner token returned any org's job).

import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyRunnerToken = vi.fn();
vi.mock("@/lib/runners/auth", () => ({
	verifyRunnerToken: (req: Request) => verifyRunnerToken(req),
}));

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
import { getServiceDb } from "@/lib/db";

/** A drizzle-ish chain resolving the job lookup to `rows`. */
function mockDb(rows: unknown[]) {
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: () => db,
		limit: () => Promise.resolve(rows),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
}

async function get(jobId: string) {
	const { GET } = await import("@/app/api/jobs/[id]/route");
	return GET(new Request(`https://console.local/api/jobs/${jobId}`), {
		params: Promise.resolve({ id: jobId }),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	verifyRunnerToken.mockResolvedValue({
		runnerId: "runner-1",
		tokenHash: "h",
		error: null,
	});
});

describe("GET /api/jobs/[id]", () => {
	it("propagates the 401 from runner auth", async () => {
		verifyRunnerToken.mockResolvedValue({
			runnerId: "",
			tokenHash: "",
			error: NextResponse.json({ error: "unauth" }, { status: 401 }),
		});
		expect((await get("job-1")).status).toBe(401);
	});

	it("404s when the job doesn't exist", async () => {
		mockDb([]);
		expect((await get("missing")).status).toBe(404);
	});

	it("403s when the job belongs to another runner", async () => {
		mockDb([{ id: "job-1", runner_id: "runner-2" }]);
		expect((await get("job-1")).status).toBe(403);
	});

	it("returns the job when the calling runner owns it", async () => {
		mockDb([{ id: "job-1", runner_id: "runner-1" }]);
		const res = await get("job-1");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ id: "job-1" });
	});
});
