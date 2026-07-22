// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// Throwaway PR to verify Mergify auto-merges a green dev PR with no manual step. Remove after.
import { describe, expect, it } from "vitest";

describe("mergify auto-merge smoke", () => {
	it("passes", () => {
		expect(true).toBe(true);
	});
});
