// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the shared account display helpers: the name fallback chain
// (name → username → email local-part → "User") and the avatar initials derived from it.

import { describe, expect, it } from "vitest";
import { displayName, userInitials } from "@/lib/user-display";

describe("displayName", () => {
	it("prefers the real name", () => {
		expect(displayName({ name: "Boris Petrov", email: "b@x.io", username: "bp" })).toBe(
			"Boris Petrov",
		);
	});

	it("falls back to the username when there is no name", () => {
		expect(displayName({ name: null, username: "bobikenobi", email: "b@x.io" })).toBe(
			"bobikenobi",
		);
	});

	it("falls back to the email local-part when there is no name or username", () => {
		expect(displayName({ email: "borislav@tovr.eu" })).toBe("borislav");
	});

	it("trims whitespace and ignores blank values", () => {
		expect(displayName({ name: "  ", username: "  ", email: "ada@x.io" })).toBe("ada");
		expect(displayName({ name: "  Spaced  " })).toBe("Spaced");
	});

	it("returns 'User' when nothing is available", () => {
		expect(displayName(null)).toBe("User");
		expect(displayName({})).toBe("User");
		expect(displayName({ name: null, username: null, email: null })).toBe("User");
	});
});

describe("userInitials", () => {
	it("uses the first letters of the first two words for a multi-word name", () => {
		expect(userInitials({ name: "Boris Petrov" })).toBe("BP");
	});

	it("splits on dots/underscores/hyphens too", () => {
		expect(userInitials({ name: "ada-lovelace" })).toBe("AL");
		expect(userInitials({ username: "jane.doe" })).toBe("JD");
	});

	it("uses the first two characters for a single token", () => {
		expect(userInitials({ name: "Boris" })).toBe("BO");
		expect(userInitials({ email: "borislav@tovr.eu" })).toBe("BO"); // local-part "borislav"
	});

	it("collapses the 'User' placeholder to a single 'U'", () => {
		expect(userInitials(null)).toBe("U");
		expect(userInitials({})).toBe("U");
	});
});
