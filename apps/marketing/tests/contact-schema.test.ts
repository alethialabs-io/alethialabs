// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	contactLeadSchema,
	parseContactTopic,
	type ContactLeadInput,
} from "../lib/validations/contact.schema";

/** A submission that passes for every topic once the topic's own fields are added. */
function lead(overrides: Partial<ContactLeadInput>): Partial<ContactLeadInput> {
	return {
		topic: "other",
		email: "jordan@acme.com",
		name: "Jordan Rivera",
		country: "BG",
		consent: true,
		...overrides,
	};
}

/** The paths of every issue a parse reported, for asserting which field failed. */
function failedPaths(input: Partial<ContactLeadInput>): string[] {
	const result = contactLeadSchema.safeParse(input);
	return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
}

describe("parseContactTopic", () => {
	it("accepts each known topic", () => {
		expect(parseContactTopic("demo")).toBe("demo");
		expect(parseContactTopic("enterprise")).toBe("enterprise");
		expect(parseContactTopic("services")).toBe("services");
		expect(parseContactTopic("other")).toBe("other");
	});

	it("falls back on a missing, unknown or differently cased value", () => {
		expect(parseContactTopic(undefined)).toBe("demo");
		expect(parseContactTopic("sales")).toBe("demo");
		expect(parseContactTopic("Services")).toBe("demo");
		expect(parseContactTopic("nope", "enterprise")).toBe("enterprise");
	});

	it("reads the first value of a repeated parameter", () => {
		expect(parseContactTopic(["services", "demo"])).toBe("services");
	});
});

describe("contactLeadSchema topic rules", () => {
	it("asks nothing extra for 'Something else'", () => {
		expect(failedPaths(lead({ topic: "other" }))).toEqual([]);
	});

	it("requires a company size, but no product interest, for a services project", () => {
		expect(failedPaths(lead({ topic: "services" }))).toEqual(["companySize"]);
		expect(failedPaths(lead({ topic: "services", companySize: "11–50" }))).toEqual([]);
	});

	it("requires both company size and product interest for a demo or a trial", () => {
		for (const topic of ["demo", "enterprise"] as const) {
			expect(failedPaths(lead({ topic })).sort()).toEqual(["companySize", "interest"]);
			expect(
				failedPaths(lead({ topic, companySize: "51–200", interest: "Enterprise governance" })),
			).toEqual([]);
		}
	});

	it("refuses an unknown topic", () => {
		const result = contactLeadSchema.safeParse({ ...lead({}), topic: "sales" });
		expect(result.success).toBe(false);
	});
});
