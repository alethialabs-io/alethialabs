// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// Throwaway PR to verify Mergify auto-merges a green dev PR with no manual step. Remove after.
// Imports a real source module (non-vacuous, satisfies the open-core anti-vacuous-test guard).
import { describe, expect, it } from "vitest";
import { cn } from "@repo/ui/utils";

describe("mergify auto-merge smoke", () => {
	it("cn merges class names", () => {
		expect(cn("a", false && "b", "c")).toContain("a");
		expect(cn("a", "c")).toContain("c");
	});
});
