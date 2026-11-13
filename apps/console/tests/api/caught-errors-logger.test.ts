// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// API routes report a caught error through the structured logger, with the error under `err`
// (#6648). The `err` serializer (lib/observability/log.ts) then decides what is written; a raw
// `console.error(msg, err)` would print every enumerable field of the error instead. This file
// covers the routes whose own test files do not exercise the failure path: the payment-hold sweep,
// the platform queue probe, the runner heartbeat, and the three CLI repository listings.

import { beforeEach, describe, expect, it, vi } from "vitest";

const logError = vi.fn();
vi.mock("@/lib/observability/log", () => {
	const l = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: logError, child: () => l };
	return { log: l };
});

const runPaymentHoldSweep = vi.fn();
vi.mock("@/lib/billing/payment-holds/sweeper", () => ({
	runPaymentHoldSweep: () => runPaymentHoldSweep(),
}));
vi.mock("@/lib/auth/internal-auth", () => ({ isInternalAuthorized: () => true }));

vi.mock("@/lib/platform/auth", () => ({ verifyPlatformSecret: () => null }));
vi.mock("@/lib/runners/auth", () => ({
	verifyRunnerToken: async () => ({ runnerId: "runner-1", tokenHash: "h" }),
}));
vi.mock("@/lib/cli/auth", () => ({ verifyCliToken: async () => ({}) }));

const execute = vi.fn();
vi.mock("@/lib/db", () => ({ getServiceDb: () => ({ execute }) }));

beforeEach(() => {
	vi.clearAllMocks();
	vi.unstubAllGlobals();
	process.env.ALETHIA_CRON_SECRET = "cron-secret";
});

describe("a caught error reaches the logger under `err`", () => {
	it("from the internal payment-hold sweep", async () => {
		const failure = new Error("sweep exploded");
		runPaymentHoldSweep.mockRejectedValue(failure);
		const { POST } = await import("@/app/api/internal/payment-holds/sweep/route");
		const res = await POST(new Request("https://console.local/api/internal/payment-holds/sweep", { method: "POST" }));
		expect(res.status).toBe(500);
		expect(logError).toHaveBeenCalledWith("[billing] payment-hold sweep (internal route) failed", {
			err: failure,
		});
	});

	it("from the platform queue probe's offline-runner sweep", async () => {
		const failure = new Error("sweep_offline_runners failed");
		execute.mockImplementation((query: { queryChunks?: unknown[] }) => {
			if (JSON.stringify(query.queryChunks).includes("sweep_offline_runners")) {
				return Promise.reject(failure);
			}
			return Promise.resolve([{ recover_stale_jobs: 0, queued: 0 }]);
		});
		const { POST } = await import("@/app/api/platform/queue/route");
		const res = await POST(new Request("https://console.local/api/platform/queue", { method: "POST" }));
		expect(res.status).toBe(200);
		expect(logError).toHaveBeenCalledWith("[platform/queue] sweep_offline_runners failed", {
			err: failure,
		});
	});

	it("from the runner heartbeat", async () => {
		const failure = new Error("heartbeat write failed");
		execute.mockRejectedValue(failure);
		const { POST } = await import("@/app/api/runners/heartbeat/route");
		const res = await POST(
			new Request("https://console.local/api/runners/heartbeat", { method: "POST", body: "{}" }),
		);
		expect(res.status).toBe(500);
		expect(logError).toHaveBeenCalledWith("Heartbeat error", { err: failure });
	});

	it.each([
		["github", "GitHub"],
		["gitlab", "GitLab"],
		["bitbucket", "Bitbucket"],
	] as const)("from the CLI %s repository listing", async (provider, name) => {
		const failure = new TypeError("fetch failed");
		vi.stubGlobal("fetch", () => Promise.reject(failure));
		const routes = {
			github: () => import("@/app/api/cli/repositories/github/route"),
			gitlab: () => import("@/app/api/cli/repositories/gitlab/route"),
			bitbucket: () => import("@/app/api/cli/repositories/bitbucket/route"),
		};
		const { GET } = await routes[provider]();
		const res = await GET(
			new Request(`https://console.local/api/cli/repositories/${provider}`, {
				headers: { "X-Provider-Token": "provider-token" },
			}),
		);
		expect(res.status).toBe(500);
		expect(logError).toHaveBeenCalledWith(`[CLI] Error fetching ${name} repositories`, {
			err: failure,
		});
	});
});
