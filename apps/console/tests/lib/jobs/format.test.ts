// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { formatDuration, JOB_TYPES } from "@/lib/jobs/format";
import { provisionJobType } from "@/lib/db/schema/enums";

describe("formatDuration", () => {
	it("renders sub-minute spans in seconds", () => {
		expect(formatDuration(42_000)).toBe("42s");
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(500)).toBe("0s"); // floors sub-second
	});

	it("renders minute+second spans", () => {
		expect(formatDuration(60_000)).toBe("1m 0s");
		expect(formatDuration(72_000)).toBe("1m 12s");
		expect(formatDuration(125_000)).toBe("2m 5s");
	});
});

describe("JOB_TYPES catalog", () => {
	it("has an entry for every provision job type", () => {
		for (const t of provisionJobType.enumValues) {
			expect(JOB_TYPES[t]).toBeDefined();
			expect(JOB_TYPES[t].label).toBeTruthy();
			expect(JOB_TYPES[t].description).toBeTruthy();
			expect(JOB_TYPES[t].icon).toBeTypeOf("object"); // a lucide component
		}
	});
});
