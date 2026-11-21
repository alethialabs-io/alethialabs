// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The free daily job quota's fail-open path (lib/billing/job-quota.ts, REL-L11 #6912). A count that
// cannot be read still admits the job, and now raises the platform operator's fail-open alert instead
// of passing silently. The counting itself runs against real Postgres in
// tests/integration/job-quota.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ fail: false, used: 0 }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/billing/queries", () => ({
	getOrgBilling: vi.fn(async () => ({ plan: "community" })),
}));
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		select: () => ({
			from: () => ({
				where: () =>
					db.fail
						? Promise.reject(new Error("connection terminated"))
						: Promise.resolve([{ c: db.used }]),
			}),
		}),
	}),
}));
vi.mock("@/lib/abuse/platform-alert", () => ({
	COST_GUARD_FAILED_OPEN_EVENT: "system.platform.cost_guard_failed_open",
	raisePlatformAbuseAlert: vi.fn(() => true),
}));

import { raisePlatformAbuseAlert } from "@/lib/abuse/platform-alert";
import { ABUSE_LIMITS } from "@/lib/abuse/limits";
import { assertJobQuotaAllowed, freeDailyJobQuota } from "@/lib/billing/job-quota";
import { UsageLimitError } from "@/lib/billing/usage-guard";

beforeEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
	db.fail = false;
	db.used = 0;
});

describe("assertJobQuotaAllowed", () => {
	it("admits the job and raises the fail-open platform alert when the count errors", async () => {
		db.fail = true;
		await expect(assertJobQuotaAllowed("org-1")).resolves.toBeUndefined();
		expect(raisePlatformAbuseAlert).toHaveBeenCalledTimes(1);
		const alert = vi.mocked(raisePlatformAbuseAlert).mock.calls[0]?.[0];
		expect(alert).toMatchObject({
			event: "system.platform.cost_guard_failed_open",
			subject: "free_daily_jobs",
			severity: "critical",
		});
		expect(alert?.summary).toContain("connection terminated");
	});

	it("raises nothing when the count reads and is under the cap", async () => {
		db.used = 1;
		await expect(assertJobQuotaAllowed("org-1")).resolves.toBeUndefined();
		expect(raisePlatformAbuseAlert).not.toHaveBeenCalled();
	});

	it("refuses at the table's cap, read through its env override", async () => {
		vi.stubEnv(ABUSE_LIMITS.free_daily_jobs.env, "4");
		expect(freeDailyJobQuota()).toBe(4);
		db.used = 4;
		await expect(assertJobQuotaAllowed("org-1")).rejects.toBeInstanceOf(UsageLimitError);
	});

	it("uses the table's default when no override is set", () => {
		expect(freeDailyJobQuota()).toBe(ABUSE_LIMITS.free_daily_jobs.defaultValue);
	});
});
