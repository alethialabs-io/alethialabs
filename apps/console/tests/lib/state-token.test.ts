// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mintStateToken, verifyStateToken } from "@/lib/runners/state-token";

const saved = process.env.BETTER_AUTH_SECRET;
beforeEach(() => {
	process.env.BETTER_AUTH_SECRET = "test-secret-aaaaaaaaaaaaaaaaaaaaaaaa";
});
afterEach(() => {
	if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
	else process.env.BETTER_AUTH_SECRET = saved;
});

const KEY = "projects/p-1/e-1/tofu.tfstate";

describe("mint/verifyStateToken", () => {
	it("round-trips the job id + state key", async () => {
		const tok = await mintStateToken({ jobId: "job-1", stateKey: KEY });
		expect(await verifyStateToken(tok)).toEqual({ jobId: "job-1", key: KEY });
	});

	it("rejects a token signed with a different secret", async () => {
		const tok = await mintStateToken({ jobId: "job-1", stateKey: KEY });
		process.env.BETTER_AUTH_SECRET = "a-totally-different-secret-value-xx";
		expect(await verifyStateToken(tok)).toBeNull();
	});

	it("rejects an expired token", async () => {
		const tok = await mintStateToken({
			jobId: "job-1",
			stateKey: KEY,
			ttlSeconds: -10,
		});
		expect(await verifyStateToken(tok)).toBeNull();
	});

	it("rejects a tampered token", async () => {
		const tok = await mintStateToken({ jobId: "job-1", stateKey: KEY });
		expect(await verifyStateToken(tok.slice(0, -3) + "xyz")).toBeNull();
	});

	it("rejects garbage", async () => {
		expect(await verifyStateToken("not-a-jwt")).toBeNull();
	});
});
