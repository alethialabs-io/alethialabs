// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `documentSchema` is the one place a pinned knowledge document's constraints are stated: the
// `upsertAgentContext` action validates with it and the destructive-audit fixture seeds through it
// (#5683). These pin what it accepts and rejects, so a loosening shows up here rather than as a
// fixture the product could never have written.

import { describe, expect, it } from "vitest";
import { documentSchema } from "@/lib/ai/knowledge-schema";
import { KNOWLEDGE_LIMIT } from "@/lib/ai/knowledge-limits";

const DOC = {
	id: "doc-1",
	title: "Runbook",
	content: "Restart the ingress before the database.",
	updated_at: "2026-10-08T00:00:00.000Z",
};

describe("documentSchema", () => {
	it("accepts a well-formed document", () => {
		expect(documentSchema.safeParse(DOC).success).toBe(true);
	});

	it("accepts content exactly at KNOWLEDGE_LIMIT", () => {
		expect(documentSchema.safeParse({ ...DOC, content: "x".repeat(KNOWLEDGE_LIMIT) }).success).toBe(
			true,
		);
	});

	it.each([
		["an empty title", { ...DOC, title: "" }],
		["a whitespace-only title (trimmed before the length check)", { ...DOC, title: "   " }],
		["a title over 200 characters", { ...DOC, title: "t".repeat(201) }],
		["an empty id", { ...DOC, id: "" }],
		["content over KNOWLEDGE_LIMIT", { ...DOC, content: "x".repeat(KNOWLEDGE_LIMIT + 1) }],
		["a missing updated_at", { id: DOC.id, title: DOC.title, content: DOC.content }],
	])("rejects %s", (_label, doc) => {
		expect(documentSchema.safeParse(doc).success).toBe(false);
	});
});
