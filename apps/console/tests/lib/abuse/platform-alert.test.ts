// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The abuse ceilings' platform alert (lib/abuse/platform-alert.ts, REL-L11 #6912): it goes through
// the existing alert pipeline on the operator org, its keys are in the alert catalog, and it is
// latched per (event, subject) so a database outage does not emit on every request.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/alerts/emit", () => ({ emitAlertEvent: vi.fn(async () => 1) }));
vi.mock("@/lib/observability/log", () => ({ log: { error: vi.fn(), warn: vi.fn() } }));

import { CATEGORIES } from "@/lib/alerts/catalog";
import { emitAlertEvent } from "@/lib/alerts/emit";
import { log } from "@/lib/observability/log";
import {
	COST_GUARD_FAILED_OPEN_EVENT,
	FREE_AI_PAUSED_EVENT,
	PLATFORM_ALERT_LATCH_MS,
	type PlatformAbuseAlert,
	raisePlatformAbuseAlert,
	resetPlatformAlertLatches,
} from "@/lib/abuse/platform-alert";

const OPERATOR_ORG = "00000000-0000-4000-8000-000000000001";
const T0 = Date.UTC(2026, 10, 21, 12, 0);

const failedOpen = (subject = "free_daily_jobs"): PlatformAbuseAlert => ({
	event: COST_GUARD_FAILED_OPEN_EVENT,
	subject,
	title: "Free job quota check failed open",
	summary: "count failed",
	severity: "critical",
});

beforeEach(() => {
	vi.clearAllMocks();
	resetPlatformAlertLatches();
	vi.stubEnv("ALETHIA_PLATFORM_ALERT_ORG_ID", OPERATOR_ORG);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("raisePlatformAbuseAlert", () => {
	it("emits on the operator org through the existing pipeline, with the subject as the resource", () => {
		expect(raisePlatformAbuseAlert(failedOpen(), T0)).toBe(true);
		expect(emitAlertEvent).toHaveBeenCalledWith(OPERATOR_ORG, COST_GUARD_FAILED_OPEN_EVENT, {
			title: "Free job quota check failed open",
			summary: "count failed",
			severity: "critical",
			resource_type: "abuse_ceiling",
			resource_id: "free_daily_jobs",
		});
		expect(log.error).toHaveBeenCalledTimes(1);
	});

	it("latches a repeat within the window (logs, does not emit) and emits again after it", () => {
		raisePlatformAbuseAlert(failedOpen(), T0);
		expect(raisePlatformAbuseAlert(failedOpen(), T0 + PLATFORM_ALERT_LATCH_MS - 1)).toBe(false);
		expect(emitAlertEvent).toHaveBeenCalledTimes(1);
		expect(log.error).toHaveBeenCalledTimes(2);
		expect(raisePlatformAbuseAlert(failedOpen(), T0 + PLATFORM_ALERT_LATCH_MS)).toBe(true);
		expect(emitAlertEvent).toHaveBeenCalledTimes(2);
	});

	it("latches per subject: a second guard failing still emits", () => {
		raisePlatformAbuseAlert(failedOpen("free_daily_jobs"), T0);
		expect(raisePlatformAbuseAlert(failedOpen("free_ai_pool"), T0 + 1)).toBe(true);
		expect(emitAlertEvent).toHaveBeenCalledTimes(2);
	});

	it("only logs when no operator org is configured", () => {
		vi.stubEnv("ALETHIA_PLATFORM_ALERT_ORG_ID", "");
		expect(raisePlatformAbuseAlert(failedOpen(), T0)).toBe(false);
		expect(emitAlertEvent).not.toHaveBeenCalled();
		expect(log.error).toHaveBeenCalledTimes(1);
	});

	it("never throws when the emit rejects", async () => {
		vi.mocked(emitAlertEvent).mockRejectedValueOnce(new Error("db down"));
		expect(() => raisePlatformAbuseAlert(failedOpen(), T0)).not.toThrow();
		await vi.waitFor(() => expect(log.error).toHaveBeenCalledTimes(2));
	});

	it("both keys are live events in the alert catalog's platform group", () => {
		const platform = CATEGORIES.find((c) => c.id === "platform");
		for (const key of [COST_GUARD_FAILED_OPEN_EVENT, FREE_AI_PAUSED_EVENT]) {
			expect(platform?.events.find((e) => e.key === key)?.live).toBe(true);
		}
	});
});
