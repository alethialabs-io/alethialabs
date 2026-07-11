// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	AI_TOPUP_UPSELL_THRESHOLD,
	formatCountdown,
	isNearAiLimit,
	pctOf,
	sessionResetLabel,
	weeklyResetLabel,
} from "@/lib/billing/ai-usage-format";

const NOW = Date.UTC(2026, 6, 7, 12, 0, 0); // Tue 2026-07-07 12:00:00Z — fixed clock

describe("formatCountdown", () => {
	it("renders hr + min for multi-hour deltas", () => {
		expect(formatCountdown(4 * 3_600_000 + 48 * 60_000)).toBe("4 hr 48 min");
	});

	it("drops the minutes part when it is zero", () => {
		expect(formatCountdown(5 * 3_600_000)).toBe("5 hr");
	});

	it("renders minutes only under an hour", () => {
		expect(formatCountdown(48 * 60_000)).toBe("48 min");
	});

	it("renders days for multi-day deltas", () => {
		expect(formatCountdown(2 * 86_400_000 + 3 * 3_600_000)).toBe("2 days 3 hr");
		expect(formatCountdown(86_400_000)).toBe("1 day");
	});

	it("floors sub-minute deltas to 'under a minute'", () => {
		expect(formatCountdown(30_000)).toBe("under a minute");
		expect(formatCountdown(0)).toBe("under a minute");
		expect(formatCountdown(Number.NaN)).toBe("under a minute");
	});
});

describe("sessionResetLabel", () => {
	it("counts down to the session reset", () => {
		const iso = new Date(NOW + 4 * 3_600_000 + 48 * 60_000).toISOString();
		expect(sessionResetLabel(iso, NOW)).toBe("Resets in 4 hr 48 min");
	});

	it("shows the idle state when there is no active session", () => {
		expect(sessionResetLabel(null, NOW)).toBe("Starts on first use");
	});

	it("degrades to 'Resets soon' when the reset moment has passed", () => {
		expect(sessionResetLabel(new Date(NOW - 1_000).toISOString(), NOW)).toBe(
			"Resets soon",
		);
	});

	it("treats an unparsable ISO as idle", () => {
		expect(sessionResetLabel("nonsense", NOW)).toBe("Starts on first use");
	});
});

describe("weeklyResetLabel", () => {
	it("renders the local weekday + time of the reset", () => {
		// Tue 2026-07-07 10:59 local — assert with a pinned locale + UTC-stable input.
		const iso = new Date(Date.UTC(2026, 6, 7, 10, 59, 0)).toISOString();
		const label = weeklyResetLabel(iso, NOW - 86_400_000, "en-US");
		expect(label).toMatch(/^Resets \w{3} \d{1,2}:\d{2}/);
	});

	it("degrades to 'Resets soon' when the reset moment has passed", () => {
		expect(weeklyResetLabel(new Date(NOW - 1_000).toISOString(), NOW)).toBe(
			"Resets soon",
		);
	});

	it("renders a dash for an unparsable ISO", () => {
		expect(weeklyResetLabel("nonsense", NOW)).toBe("—");
	});
});

describe("pctOf", () => {
	it("rounds and clamps to 0–100", () => {
		expect(pctOf(50, 200)).toBe(25);
		expect(pctOf(300, 200)).toBe(100);
		expect(pctOf(-5, 200)).toBe(0);
	});

	it("returns 0 when there is no budget", () => {
		expect(pctOf(50, 0)).toBe(0);
	});
});

describe("isNearAiLimit", () => {
	const base = { sessionBudget: 100, weeklyBudget: 1_000 };

	it("fires exactly at the threshold on either window", () => {
		expect(
			isNearAiLimit({
				...base,
				sessionUsed: 100 * AI_TOPUP_UPSELL_THRESHOLD,
				weeklyUsed: 0,
			}),
		).toBe(true);
		expect(
			isNearAiLimit({
				...base,
				sessionUsed: 0,
				weeklyUsed: 1_000 * AI_TOPUP_UPSELL_THRESHOLD,
			}),
		).toBe(true);
	});

	it("stays quiet below the threshold", () => {
		expect(isNearAiLimit({ ...base, sessionUsed: 79, weeklyUsed: 790 })).toBe(
			false,
		);
	});

	it("never fires on a zero budget", () => {
		expect(
			isNearAiLimit({
				sessionUsed: 10,
				sessionBudget: 0,
				weeklyUsed: 10,
				weeklyBudget: 0,
			}),
		).toBe(false);
	});
});
