// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveStateRequest = vi.fn();
vi.mock("@/lib/runners/state-auth", () => ({
	resolveStateRequest: (...a: unknown[]) => resolveStateRequest(...a),
}));

const validateStateLock = vi.fn();
vi.mock("@/lib/runners/state-lock", () => ({
	validateStateLock: (...a: unknown[]) => validateStateLock(...a),
}));

const storage = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock("@/lib/storage", () => ({ storage }));

import { DELETE, GET, POST } from "@/app/api/jobs/[id]/state/route";

const KEY = "projects/p-1/e-1/tofu.tfstate";
const params = Promise.resolve({ id: "job-1" });

beforeEach(() => {
	vi.clearAllMocks();
	resolveStateRequest.mockResolvedValue({ stateKey: KEY, jobId: "job-1" });
});

describe("state route", () => {
	it("GET propagates an auth error", async () => {
		resolveStateRequest.mockResolvedValue({
			error: NextResponse.json({ error: "no" }, { status: 403 }),
		});
		expect((await GET(new Request("https://x/s"), { params })).status).toBe(403);
	});

	it("GET 404s when there is no state yet", async () => {
		storage.get.mockResolvedValue(null);
		expect((await GET(new Request("https://x/s"), { params })).status).toBe(404);
	});

	it("GET returns the state bytes", async () => {
		storage.get.mockResolvedValue(new Uint8Array([1, 2, 3]));
		const res = await GET(new Request("https://x/s"), { params });
		expect(res.status).toBe(200);
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("POST 409s when the write presents no valid held lock (fence)", async () => {
		validateStateLock.mockResolvedValue(false);
		const res = await POST(
			new Request("https://x/s?ID=lock-1", { method: "POST", body: "{}" }),
			{ params },
		);
		expect(res.status).toBe(409);
		expect(storage.put).not.toHaveBeenCalled();
	});

	it("POST 409s when ?ID= is missing entirely", async () => {
		const res = await POST(
			new Request("https://x/s", { method: "POST", body: "{}" }),
			{ params },
		);
		expect(res.status).toBe(409);
		expect(validateStateLock).not.toHaveBeenCalled();
	});

	it("POST writes state when the lock fence passes", async () => {
		validateStateLock.mockResolvedValue(true);
		const res = await POST(
			new Request("https://x/s?ID=lock-1", {
				method: "POST",
				body: new Uint8Array([9, 9]),
			}),
			{ params },
		);
		expect(res.status).toBe(200);
		expect(storage.put).toHaveBeenCalledWith(
			expect.any(String),
			KEY,
			expect.any(Uint8Array),
			"application/json",
		);
	});

	it("DELETE purges the state object", async () => {
		const res = await DELETE(new Request("https://x/s", { method: "DELETE" }), {
			params,
		});
		expect(res.status).toBe(200);
		expect(storage.del).toHaveBeenCalledWith(expect.any(String), KEY);
	});
	// #7290: a cancelled apply's interrupted tofu writes its final state after the cancel flip. Only
	// that write opts into the cancelled-holder admission; a read and a purge never do.
	it("POST (the final write) opts into the cancelled-holder admission", async () => {
		validateStateLock.mockResolvedValue(true);
		await POST(new Request("https://x/s?ID=lock-1", { method: "POST", body: "{}" }), { params });
		expect(resolveStateRequest).toHaveBeenCalledWith(expect.any(Request), "job-1", {
			allowCancelledHolder: true,
		});
	});

	it("GET and DELETE do not opt in — a cancelled job may not read or purge state", async () => {
		storage.get.mockResolvedValue(null);
		await GET(new Request("https://x/s"), { params });
		await DELETE(new Request("https://x/s", { method: "DELETE" }), { params });
		for (const call of resolveStateRequest.mock.calls) {
			expect(call).toHaveLength(2);
		}
	});
});
