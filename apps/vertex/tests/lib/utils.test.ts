// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";

describe("cn utility", () => {
	it("merges class names", () => {
		expect(cn("a", "b")).toBe("a b");
	});

	it("handles conditional classes", () => {
		expect(cn("base", false && "hidden", "visible")).toBe("base visible");
	});

	it("dedupes tailwind classes", () => {
		expect(cn("p-4", "p-8")).toBe("p-8");
	});

	it("handles undefined and null", () => {
		expect(cn("a", undefined, null, "b")).toBe("a b");
	});

	it("handles empty inputs", () => {
		expect(cn()).toBe("");
	});
});
