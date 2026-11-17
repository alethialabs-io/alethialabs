// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6755: `toActionFailure` is the one place a thrown value becomes an `ActionFailure`. These tests
// pin its three branches and the two sentences a `network` failure is described with.

import { describe, expect, it } from "vitest";
import {
	ActionFailure,
	describeActionError,
	isFrameworkControlFlow,
	toActionFailure,
} from "@/lib/actions/result";

/** An error carrying the `digest` Next puts on its control-flow signals. */
function withDigest(digest: unknown): Error {
	return Object.assign(new Error("control flow"), { digest });
}

describe("toActionFailure", () => {
	it("returns an ActionFailure as it is", () => {
		const failure = new ActionFailure({ kind: "conflict", message: "Taken." });
		expect(toActionFailure(failure, true)).toBe(failure);
	});

	it("turns any other thrown value into a network failure that carries `sent`", () => {
		expect(toActionFailure(new TypeError("Failed to fetch"), true).error).toEqual({
			kind: "network",
			sent: true,
		});
		expect(toActionFailure("a string", false).error).toEqual({ kind: "network", sent: false });
		expect(toActionFailure(undefined, true).error).toEqual({ kind: "network", sent: true });
	});

	it("rethrows Next's control flow untouched", () => {
		const redirect = withDigest("NEXT_REDIRECT;push;/acme;307;");
		expect(() => toActionFailure(redirect, true)).toThrow(redirect);
	});
});

describe("isFrameworkControlFlow", () => {
	it("is true for a redirect, a not-found and an HTTP fallback digest", () => {
		expect(isFrameworkControlFlow(withDigest("NEXT_REDIRECT;replace;/login;307;"))).toBe(true);
		expect(isFrameworkControlFlow(withDigest("NEXT_NOT_FOUND"))).toBe(true);
		expect(isFrameworkControlFlow(withDigest("NEXT_HTTP_ERROR_FALLBACK;404"))).toBe(true);
	});

	it("is false for a server error's digest, a non-string digest, and values with no digest", () => {
		expect(isFrameworkControlFlow(withDigest("2891734650"))).toBe(false);
		expect(isFrameworkControlFlow(withDigest(42))).toBe(false);
		expect(isFrameworkControlFlow(new Error("boom"))).toBe(false);
		expect(isFrameworkControlFlow(null)).toBe(false);
		expect(isFrameworkControlFlow("NEXT_REDIRECT")).toBe(false);
	});
});

describe("describeActionError for a network failure", () => {
	it("says nothing was changed when the request was never sent", () => {
		expect(describeActionError({ kind: "network", sent: false })).toBe(
			"You appear to be offline. Nothing was changed.",
		);
	});

	it("says the change could not be confirmed when the request was sent", () => {
		expect(describeActionError({ kind: "network", sent: true })).toBe(
			"We couldn't confirm that change. Check it before trying again.",
		);
	});
});
