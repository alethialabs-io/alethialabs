// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure-schema tests for the support-cases validation contract: the submit-case + post-message
// zod schemas (accept a well-formed case, reject each malformed field, optional-contact +
// channel default) and the display-label maps (a key for every enum value — guards a future
// enum addition from silently breaking the UI copy).

import { describe, expect, it } from "vitest";
import {
	supportAbuseCategory,
	supportCaseCategory,
	supportCaseSeverity,
	supportCaseStatus,
	supportCaseType,
} from "@/lib/db/schema/enums";
import {
	postMessageSchema,
	submitCaseSchema,
	SUPPORT_ABUSE_CATEGORY_LABELS,
	SUPPORT_CASE_TYPE_LABELS,
	SUPPORT_CATEGORY_LABELS,
	SUPPORT_SEVERITY_GUIDANCE,
	SUPPORT_SEVERITY_LABELS,
	SUPPORT_STATUS_LABELS,
} from "@/lib/validations/support";

/** A fully-populated, valid new-case submission used as the happy-path baseline. */
const validCase = {
	type: "technical",
	category: "clusters",
	severity: "high",
	subject: "Cluster is unreachable",
	description: "My production cluster stopped responding after the last apply.",
	context: { projectId: "proj-1", region: "eu-central-1" },
	contact: { notifyEmail: "me@acme.io", ccEmails: ["ops@acme.io"], channel: "email" },
	abuse: undefined,
} as const;

describe("submitCaseSchema", () => {
	it("accepts a full, well-formed case", () => {
		const r = submitCaseSchema.safeParse(validCase);
		expect(r.success).toBe(true);
	});

	it("rejects a subject shorter than 3 chars", () => {
		expect(
			submitCaseSchema.safeParse({ ...validCase, subject: "ab" }).success,
		).toBe(false);
	});

	it("rejects a description shorter than 10 chars", () => {
		expect(
			submitCaseSchema.safeParse({ ...validCase, description: "too short" }).success,
		).toBe(false);
	});

	it("rejects an unknown case type", () => {
		expect(
			submitCaseSchema.safeParse({ ...validCase, type: "spam" }).success,
		).toBe(false);
	});

	it("rejects an unknown category", () => {
		expect(
			submitCaseSchema.safeParse({ ...validCase, category: "spaceships" }).success,
		).toBe(false);
	});

	it("rejects an unknown severity", () => {
		expect(
			submitCaseSchema.safeParse({ ...validCase, severity: "critical" }).success,
		).toBe(false);
	});

	it("rejects an invalid contact.notifyEmail", () => {
		expect(
			submitCaseSchema.safeParse({
				...validCase,
				contact: { notifyEmail: "not-an-email", channel: "email" },
			}).success,
		).toBe(false);
	});

	it("parses with contact omitted (contact is optional)", () => {
		const { contact: _drop, ...noContact } = validCase;
		const parsed = submitCaseSchema.parse(noContact);
		expect(parsed.contact).toBeUndefined();
	});

	it("defaults contact.channel to \"email\" when omitted", () => {
		const parsed = submitCaseSchema.parse({
			...validCase,
			contact: { notifyEmail: "me@acme.io" },
		});
		expect(parsed.contact?.channel).toBe("email");
	});
});

describe("postMessageSchema", () => {
	const uuid = "11111111-1111-4111-8111-111111111111";

	it("accepts a valid uuid caseId + body", () => {
		expect(postMessageSchema.safeParse({ caseId: uuid, body: "Any update?" }).success).toBe(
			true,
		);
	});

	it("rejects a non-uuid caseId", () => {
		expect(
			postMessageSchema.safeParse({ caseId: "not-a-uuid", body: "hi" }).success,
		).toBe(false);
	});

	it("rejects an empty body", () => {
		expect(postMessageSchema.safeParse({ caseId: uuid, body: "" }).success).toBe(false);
	});

	it("rejects an oversized body (>10000 chars)", () => {
		expect(
			postMessageSchema.safeParse({ caseId: uuid, body: "a".repeat(10001) }).success,
		).toBe(false);
	});
});

describe("label maps cover every enum value", () => {
	it("has a type label for every supportCaseType value", () => {
		for (const v of supportCaseType.enumValues) {
			expect(SUPPORT_CASE_TYPE_LABELS[v]).toBeTruthy();
		}
	});

	it("has a category label for every supportCaseCategory value", () => {
		for (const v of supportCaseCategory.enumValues) {
			expect(SUPPORT_CATEGORY_LABELS[v]).toBeTruthy();
		}
	});

	it("has a severity label + guidance for every supportCaseSeverity value", () => {
		for (const v of supportCaseSeverity.enumValues) {
			expect(SUPPORT_SEVERITY_LABELS[v]).toBeTruthy();
			expect(SUPPORT_SEVERITY_GUIDANCE[v]).toBeTruthy();
		}
	});

	it("has a status label for every supportCaseStatus value", () => {
		for (const v of supportCaseStatus.enumValues) {
			expect(SUPPORT_STATUS_LABELS[v]).toBeTruthy();
		}
	});

	it("has an abuse-category label for every supportAbuseCategory value", () => {
		for (const v of supportAbuseCategory.enumValues) {
			expect(SUPPORT_ABUSE_CATEGORY_LABELS[v]).toBeTruthy();
		}
	});
});
