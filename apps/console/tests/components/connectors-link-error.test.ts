// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The sentence a failed git-provider connection shows (#6816): chosen from the failure's code and
// status, the same on the board and in the repository selector, and never containing either.

import { describe, expect, it } from "vitest";
import { gitLinkFailureMessage } from "@/components/connectors/connectors-link-error";

/** Every failure shape the tests below hand the function. */
const FAILURES: unknown[] = [
	{ status: 400, code: "SOCIAL_ACCOUNT_ALREADY_LINKED", message: "Social account already linked" },
	{ status: 404, code: "PROVIDER_NOT_FOUND", message: "Provider not found" },
	{ status: 401, code: "UNAUTHORIZED", message: "Unauthorized" },
	{ status: 403, code: "INVALID_CALLBACK_URL", message: "Invalid callbackURL" },
	{ status: 429, message: "Too many requests" },
	{ status: 500, statusText: "Internal Server Error" },
	new TypeError("Failed to fetch"),
	new Error("boom"),
	"a string",
	null,
	undefined,
];

describe("gitLinkFailureMessage", () => {
	it("gives each known cause its own sentence", () => {
		expect(gitLinkFailureMessage("GitHub", FAILURES[0])).toContain("already connected to a different Alethia user");
		expect(gitLinkFailureMessage("GitHub", FAILURES[1])).toContain("GitHub is not enabled on this instance");
		expect(gitLinkFailureMessage("GitHub", FAILURES[2])).toContain("Your session has ended");
		expect(gitLinkFailureMessage("GitHub", FAILURES[4])).toContain("Too many attempts");
		expect(gitLinkFailureMessage("GitHub", FAILURES[6])).toContain("Alethia could not be reached");
	});

	it("reads a bare 401 and a bare 404 by status when there is no code", () => {
		expect(gitLinkFailureMessage("GitLab", { status: 401 })).toContain("Your session has ended");
		expect(gitLinkFailureMessage("GitLab", { status: 404 })).toContain("GitLab is not enabled on this instance");
	});

	it("falls back to one sentence that still says what to do", () => {
		const fallback = "Bitbucket could not be connected. Try again; if it keeps happening, contact support.";
		for (const failure of [FAILURES[3], FAILURES[5], FAILURES[7], FAILURES[8], FAILURES[9], FAILURES[10]]) {
			expect(gitLinkFailureMessage("Bitbucket", failure)).toBe(fallback);
		}
	});

	it("never shows a status, a code or the library's own words", () => {
		const leaked = FAILURES.map((failure) => gitLinkFailureMessage("GitHub", failure)).filter((sentence) =>
			/\d{3}|[A-Z]{2,}_[A-Z_]+|callbackURL|Failed to fetch|boom|Unauthorized/.test(sentence),
		);
		expect(leaked).toEqual([]);
	});

	it("names the provider in every sentence", () => {
		const unnamed = FAILURES.map((failure) => gitLinkFailureMessage("GitHub", failure)).filter(
			(sentence) => !sentence.includes("GitHub") && !sentence.includes("session has ended"),
		);
		expect(unnamed).toEqual([]);
	});
});
