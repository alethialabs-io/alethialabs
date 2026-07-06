// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	FEEDBACK_TOPIC_LABELS,
	FEEDBACK_TOPICS,
	feedbackSchema,
} from "@/lib/validations/feedback";

describe("feedbackSchema", () => {
	it("accepts a well-formed submission", () => {
		const r = feedbackSchema.safeParse({ topic: "bug", rating: 5, message: "Broken button" });
		expect(r.success).toBe(true);
	});

	it("rejects an unknown topic", () => {
		expect(feedbackSchema.safeParse({ topic: "spam", rating: 3, message: "hi" }).success).toBe(
			false,
		);
	});

	it("constrains the rating to 1–5 integers", () => {
		expect(feedbackSchema.safeParse({ topic: "idea", rating: 0, message: "x" }).success).toBe(false);
		expect(feedbackSchema.safeParse({ topic: "idea", rating: 6, message: "x" }).success).toBe(false);
		expect(feedbackSchema.safeParse({ topic: "idea", rating: 2.5, message: "x" }).success).toBe(false);
	});

	it("requires a non-empty, bounded message", () => {
		expect(feedbackSchema.safeParse({ topic: "other", rating: 3, message: "" }).success).toBe(false);
		expect(
			feedbackSchema.safeParse({ topic: "other", rating: 3, message: "a".repeat(2001) }).success,
		).toBe(false);
	});
});

describe("topic metadata", () => {
	it("has a human label for every topic", () => {
		for (const t of FEEDBACK_TOPICS) {
			expect(FEEDBACK_TOPIC_LABELS[t]).toBeTruthy();
		}
	});
});
