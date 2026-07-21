// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The internal capability-sweep cron route (#938). Fail-closed: 503 when ALETHIA_CRON_SECRET is unset,
// 401 without the matching bearer, 200 (and the sweep result) when authorized.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cloud-providers/capabilities/sweep", () => ({
	runCapabilitySweep: vi.fn().mockResolvedValue({ checked: 3, synced: 2 }),
}));

import { POST } from "@/app/api/internal/capabilities/sweep/route";

const original = process.env.ALETHIA_CRON_SECRET;
afterEach(() => {
	process.env.ALETHIA_CRON_SECRET = original;
	vi.clearAllMocks();
});

function post(headers?: Record<string, string>): Request {
	return new Request("http://localhost/api/internal/capabilities/sweep", {
		method: "POST",
		headers,
	});
}

describe("POST /api/internal/capabilities/sweep", () => {
	it("503s when the cron secret is unset", async () => {
		process.env.ALETHIA_CRON_SECRET = "";
		const res = await POST(post());
		expect(res.status).toBe(503);
	});

	it("401s without the matching bearer", async () => {
		process.env.ALETHIA_CRON_SECRET = "s3cret";
		const res = await POST(post({ authorization: "Bearer wrong" }));
		expect(res.status).toBe(401);
	});

	it("runs the sweep and returns its counts when authorized", async () => {
		process.env.ALETHIA_CRON_SECRET = "s3cret";
		const res = await POST(post({ authorization: "Bearer s3cret" }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ checked: 3, synced: 2 });
	});
});
