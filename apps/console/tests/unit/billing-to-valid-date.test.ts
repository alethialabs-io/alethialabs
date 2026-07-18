// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit: toValidDate coerces a billing period boundary to a valid Date or null — the guard that stops a
// stray "" (canceled-sub upsert) from crashing the organization_billing insert on a timestamptz column.

import { describe, expect, it } from "vitest";
import { toValidDate } from "@/lib/billing/queries";

describe("toValidDate", () => {
	it("passes a valid Date through", () => {
		const d = new Date("2026-07-13T01:31:39.428Z");
		expect(toValidDate(d)).toBe(d);
	});

	it("coerces the empty string (the prod crash) and blanks to null", () => {
		expect(toValidDate("")).toBeNull();
		expect(toValidDate("   ")).toBeNull();
		expect(toValidDate(null)).toBeNull();
		expect(toValidDate(undefined)).toBeNull();
	});

	it("rejects invalid dates → null", () => {
		expect(toValidDate("not-a-date")).toBeNull();
		expect(toValidDate(new Date("nope"))).toBeNull();
	});

	it("accepts an epoch-ms number or ISO string", () => {
		expect(toValidDate(1_752_370_299_428)?.getTime()).toBe(1_752_370_299_428);
		expect(toValidDate("2026-07-13T01:31:39.428Z")?.toISOString()).toBe(
			"2026-07-13T01:31:39.428Z",
		);
	});
});
