// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Paddle key VALUES are redacted wherever they appear, even when this process holds no env var with
// that value (a key echoed back in a provider error). Keys are constructed from their prefix so no
// file in the tree holds a string shaped like a real key.

import { describe, expect, it } from "vitest";
import { scrubString } from "@/lib/observability/scrub";

describe("scrubString — Paddle key shapes", () => {
	it.each([
		["a sandbox API key", `pdl_sdbx_apikey_${"x1".repeat(12)}`],
		["a live API key", `pdl_live_apikey_${"y2".repeat(12)}`],
		["a notification secret key", `pdl_ntfset_${"z3".repeat(12)}`],
	])("redacts %s", (_label, key) => {
		const out = scrubString(`Paddle said: bad key ${key} (401)`, []);
		expect(out).not.toContain(key);
		expect(out).toBe("Paddle said: bad key [REDACTED] (401)");
	});

	it("leaves the public client token and ordinary text alone", () => {
		const text = "Initialize({ token: test_abc123 }) for pdl_ docs";
		expect(scrubString(text, [])).toBe(text);
	});
});
