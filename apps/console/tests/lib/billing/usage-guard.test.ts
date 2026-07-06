// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Managed-runner enqueue guard (lib/billing/usage-guard.ts → assertUsageAllowed). Mocked boundary:
// stub billing row + entitlements + the job-minutes query; assert the hard-block policy matrix
// (community vs paid-with-hardCap vs paid-overage) and the included-minutes threshold.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/billing/queries", () => ({ getOrgBilling: vi.fn() }));
vi.mock("@/lib/billing/plan", () => ({ resolvePlanEntitlements: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn(() => ({})) }));
vi.mock("@/lib/queries/runner-usage", () => ({ queryJobMinutesByOrg: vi.fn() }));

import { assertUsageAllowed, UsageLimitError } from "@/lib/billing/usage-guard";
import { getOrgBilling } from "@/lib/billing/queries";
import { resolvePlanEntitlements } from "@/lib/billing/plan";
import { queryJobMinutesByOrg } from "@/lib/queries/runner-usage";

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(resolvePlanEntitlements).mockReturnValue({
		quotas: { includedRunnerMinutes: 100 },
	} as never);
	vi.mocked(queryJobMinutesByOrg).mockResolvedValue([{ job_minutes: 0 }] as never);
});

it("never blocks a paid org without a hard cap (it bills overage)", async () => {
	vi.mocked(getOrgBilling).mockResolvedValue({ plan: "team", status: "active", usageHardCap: false } as never);
	await expect(assertUsageAllowed("org-1")).resolves.toBeUndefined();
	expect(queryJobMinutesByOrg).not.toHaveBeenCalled(); // short-circuits before the usage query
});

it("allows a community org still under its included minutes", async () => {
	vi.mocked(getOrgBilling).mockResolvedValue({ plan: "community", status: "none" } as never);
	vi.mocked(queryJobMinutesByOrg).mockResolvedValue([{ job_minutes: 50 }] as never);
	await expect(assertUsageAllowed("org-1")).resolves.toBeUndefined();
});

it("hard-blocks a community org at/over its included minutes (upgradable)", async () => {
	vi.mocked(getOrgBilling).mockResolvedValue({ plan: "community", status: "none" } as never);
	vi.mocked(queryJobMinutesByOrg).mockResolvedValue([{ job_minutes: 100 }] as never);
	const err = await assertUsageAllowed("org-1").catch((e) => e);
	expect(err).toBeInstanceOf(UsageLimitError);
	expect(err.upgradable).toBe(true);
});

it("hard-blocks a paid org with the cap on (not upgradable — raise/disable cap)", async () => {
	vi.mocked(getOrgBilling).mockResolvedValue({ plan: "team", status: "active", usageHardCap: true } as never);
	vi.mocked(queryJobMinutesByOrg).mockResolvedValue([{ job_minutes: 120 }] as never);
	const err = await assertUsageAllowed("org-1").catch((e) => e);
	expect(err).toBeInstanceOf(UsageLimitError);
	expect(err.upgradable).toBe(false);
});

it("treats missing billing as community (defaults)", async () => {
	vi.mocked(getOrgBilling).mockResolvedValue(null as never);
	vi.mocked(queryJobMinutesByOrg).mockResolvedValue([{ job_minutes: 100 }] as never);
	await expect(assertUsageAllowed("org-1")).rejects.toBeInstanceOf(UsageLimitError);
});
