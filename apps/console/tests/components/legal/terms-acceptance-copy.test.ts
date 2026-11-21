// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The terms-acceptance wording, its links and the record it names (#6923).

import { describe, expect, it } from "vitest";
import { ACCEPTANCE_LABELS, LEGAL_DOCUMENTS } from "@repo/legal/documents";
import {
	ACCEPTANCE_LOCALE,
	ACCEPTED_DOCUMENTS,
	type AcceptanceDocument,
	acceptanceRecord,
	checkboxLabel,
	checkboxLabelText,
	gateHeading,
	noticeLine,
	requiredMessage,
	TERMS_ACCEPTANCE_TEXT,
} from "@/components/legal/terms-acceptance-copy";

/** A resolver that makes the link targets easy to read in an assertion. */
const resolve = (path: `/${string}`): string => `https://legal.example${path}`;

/** The current Terms as the gate's server read would return them for a new person. */
const TERMS: AcceptanceDocument = {
	id: "terms",
	title: "Terms of Service",
	version: "2026-08-24",
	path: "/terms",
	firstAcceptance: true,
};

describe("the documents the box covers", () => {
	it("is every sealed acceptance-required document, and only those", () => {
		expect(ACCEPTED_DOCUMENTS.map((d) => d.id)).toEqual(
			LEGAL_DOCUMENTS.filter((d) => d.acceptanceRequired).map((d) => d.id),
		);
		expect(ACCEPTED_DOCUMENTS.map((d) => d.id)).not.toContain("privacy");
	});

	it("is published in the locale the record names", () => {
		const missing = ACCEPTED_DOCUMENTS.filter(
			(d) => !d.locales.some((l) => l === ACCEPTANCE_LOCALE),
		).map((d) => d.id);
		expect(missing).toEqual([]);
	});
});

describe("checkboxLabel", () => {
	it("names the document as a link and prints its version", () => {
		expect(checkboxLabel([TERMS], resolve)).toEqual([
			{ kind: "text", text: "I have read and accept the " },
			{
				kind: "link",
				documentId: "terms",
				text: "Terms of Service",
				href: "https://legal.example/terms",
			},
			{ kind: "text", text: " (version 2026-08-24)" },
			{ kind: "text", text: "." },
		]);
	});

	it("opens with the prefix the e2e fixture locates the box by", () => {
		expect(checkboxLabelText([TERMS])).toBe(
			"I have read and accept the Terms of Service (version 2026-08-24).",
		);
		expect(checkboxLabelText([TERMS]).startsWith(ACCEPTANCE_LABELS.checkboxPrefix)).toBe(
			true,
		);
	});

	it("lists several documents as prose, each with its version", () => {
		const other: AcceptanceDocument = {
			id: "dpa",
			title: "Data Processing Agreement",
			version: "2026-12-01",
			path: "/dpa",
			firstAcceptance: true,
		};
		expect(checkboxLabelText([TERMS, other])).toBe(
			"I have read and accept the Terms of Service (version 2026-08-24) and the Data Processing Agreement (version 2026-12-01).",
		);
	});

	it("does not link a path that is not a legal-site path", () => {
		const odd: AcceptanceDocument = { ...TERMS, path: "terms" };
		const links = checkboxLabel([odd], resolve).filter((s) => s.kind === "link");
		expect(links).toEqual([]);
	});
});

describe("noticeLine", () => {
	it("links the Privacy Policy as information, not as something accepted", () => {
		const line = noticeLine(resolve);
		expect(line.map((s) => s.text).join("")).toBe(
			"How we use your personal data is explained in our Privacy Policy.",
		);
		expect(line.filter((s) => s.kind === "link")).toEqual([
			{
				kind: "link",
				documentId: "privacy",
				text: "Privacy Policy",
				href: "https://legal.example/privacy",
			},
		]);
		expect(checkboxLabelText([TERMS])).not.toContain("Privacy");
	});
});

describe("requiredMessage", () => {
	it("names what the box accepts", () => {
		expect(requiredMessage([TERMS])).toBe("Tick the box to accept the Terms of Service.");
	});
});

describe("gateHeading", () => {
	it("tells a person with no history that this is a first agreement (#5009)", () => {
		expect(gateHeading([TERMS])).toEqual({
			heading: "Accept our Terms",
			body: "Review and accept to continue.",
		});
	});

	it("tells a person who accepted an earlier version that the Terms changed", () => {
		const copy = gateHeading([{ ...TERMS, firstAcceptance: false }]);
		expect(copy.heading).toBe("Our Terms have changed");
		expect(copy.body).toContain("nothing has been removed");
	});
});

describe("acceptanceRecord", () => {
	it("names the sealed version and content hash of each accepted document", () => {
		const terms = LEGAL_DOCUMENTS.find((d) => d.id === "terms");
		expect(acceptanceRecord(["terms"])).toEqual([
			{
				documentId: "terms",
				documentVersion: terms?.version,
				documentHash: terms?.contentHash,
				locale: "en",
			},
		]);
		const unsealed = acceptanceRecord(["terms"]).filter(
			(row) => !/^[0-9a-f]{64}$/.test(row.documentHash),
		);
		expect(unsealed).toEqual([]);
	});

	it("drops a notice and an unknown id, as the server action does", () => {
		expect(acceptanceRecord(["privacy", "nope"])).toEqual([]);
	});
});

describe("the fixed strings", () => {
	it("reuse the e2e locators' constants rather than a second copy", () => {
		expect(TERMS_ACCEPTANCE_TEXT.submit).toBe(ACCEPTANCE_LABELS.submit);
		expect(TERMS_ACCEPTANCE_TEXT.checkboxPrefix).toBe(ACCEPTANCE_LABELS.checkboxPrefix);
	});
});
