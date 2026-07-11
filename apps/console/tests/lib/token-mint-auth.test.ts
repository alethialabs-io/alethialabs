// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Pins the per-job binding on the cloud-token mint: a runner token alone no longer mints an
// arbitrary cloud token — the caller must own a live job whose provider matches the route.

import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyRunnerToken = vi.fn();
vi.mock("@/lib/runners/auth", () => ({
	verifyRunnerToken: (req: Request) => verifyRunnerToken(req),
}));

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
import { getServiceDb } from "@/lib/db";
import { authorizeTokenMint } from "@/lib/runners/token-mint-auth";

/** A drizzle-ish chain resolving the job lookup to `rows`. */
function mockJob(rows: unknown[]) {
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: () => db,
		limit: () => Promise.resolve(rows),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
}

function req(body?: unknown): Request {
	return new Request("https://console.local/api/runners/aws-token", {
		method: "POST",
		...(body === undefined
			? {}
			: { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	verifyRunnerToken.mockResolvedValue({
		runnerId: "runner-1",
		tokenHash: "h",
		operator: "managed",
		error: null,
	});
});

describe("authorizeTokenMint", () => {
	it("propagates the runner-auth error", async () => {
		verifyRunnerToken.mockResolvedValue({
			runnerId: "",
			tokenHash: "",
			operator: "",
			error: NextResponse.json({ error: "unauth" }, { status: 401 }),
		});
		const { error } = await authorizeTokenMint(req({ job_id: "j" }), "aws");
		expect(error?.status).toBe(401);
	});

	it("400s a managed runner that omits job_id", async () => {
		const { error } = await authorizeTokenMint(req(), "aws");
		expect(error?.status).toBe(400);
	});

	it("allows a self-hosted runner without job_id (back-compat)", async () => {
		verifyRunnerToken.mockResolvedValue({
			runnerId: "runner-1",
			tokenHash: "h",
			operator: "self",
			error: null,
		});
		const { error } = await authorizeTokenMint(req(), "aws");
		expect(error).toBeNull();
	});

	it("404s when the job doesn't exist", async () => {
		mockJob([]);
		const { error } = await authorizeTokenMint(req({ job_id: "missing" }), "aws");
		expect(error?.status).toBe(404);
	});

	it("403s when another runner owns the job", async () => {
		mockJob([{ runner_id: "runner-2", status: "PROCESSING", provider: "aws" }]);
		const { error } = await authorizeTokenMint(req({ job_id: "j" }), "aws");
		expect(error?.status).toBe(403);
	});

	it("409s when the job is not running", async () => {
		mockJob([{ runner_id: "runner-1", status: "QUEUED", provider: "aws" }]);
		const { error } = await authorizeTokenMint(req({ job_id: "j" }), "aws");
		expect(error?.status).toBe(409);
	});

	it("403s when the job provider doesn't match the route", async () => {
		mockJob([{ runner_id: "runner-1", status: "PROCESSING", provider: "gcp" }]);
		const { error } = await authorizeTokenMint(req({ job_id: "j" }), "aws");
		expect(error?.status).toBe(403);
	});

	it("authorizes an owned, running, provider-matched job", async () => {
		mockJob([{ runner_id: "runner-1", status: "PROCESSING", provider: "aws" }]);
		const { error } = await authorizeTokenMint(req({ job_id: "j" }), "aws");
		expect(error).toBeNull();
	});
});
