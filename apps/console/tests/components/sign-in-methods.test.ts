// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The provider step's arrangement around the last-used method. Each expectation is written
// out by hand rather than derived from OAUTH_PROVIDERS, so a change to the constants has to
// change this file too.

import { describe, expect, it } from "vitest";

import { arrangeSignInMethods } from "@/components/auth/sign-in-methods";
import type { AuthMethod } from "@/lib/stores/use-auth-prefs-store";

describe("arrangeSignInMethods", () => {
	it("keeps today's layout when nothing is remembered", () => {
		expect(arrangeSignInMethods(null)).toEqual({
			lead: null,
			wide: "github",
			grid: ["google", "gitlab", "bitbucket"],
			emailBelow: true,
		});
	});

	it("leads with a remembered GitHub and leaves the other three on the row", () => {
		expect(arrangeSignInMethods("github")).toEqual({
			lead: "github",
			wide: null,
			grid: ["google", "gitlab", "bitbucket"],
			emailBelow: true,
		});
	});

	it("leads with a remembered GitLab and moves GitHub onto the row in its place", () => {
		expect(arrangeSignInMethods("gitlab")).toEqual({
			lead: "gitlab",
			wide: null,
			grid: ["github", "google", "bitbucket"],
			emailBelow: true,
		});
	});

	it("leads with a remembered Bitbucket", () => {
		expect(arrangeSignInMethods("bitbucket")).toEqual({
			lead: "bitbucket",
			wide: null,
			grid: ["github", "google", "gitlab"],
			emailBelow: true,
		});
	});

	it("leads with a remembered Google", () => {
		expect(arrangeSignInMethods("google")).toEqual({
			lead: "google",
			wide: null,
			grid: ["github", "gitlab", "bitbucket"],
			emailBelow: true,
		});
	});

	it("leads with remembered email, keeps the providers as today, and drops the second email button", () => {
		expect(arrangeSignInMethods("email")).toEqual({
			lead: "email",
			wide: "github",
			grid: ["google", "gitlab", "bitbucket"],
			emailBelow: false,
		});
	});

	it("never offers a method twice or drops one", () => {
		const every: (AuthMethod | null)[] = [null, "github", "google", "gitlab", "bitbucket", "email"];
		for (const last of every) {
			const { lead, wide, grid, emailBelow } = arrangeSignInMethods(last);
			const shown = [lead, wide, ...grid, emailBelow ? "email" : null].filter(
				(m) => m !== null,
			);
			expect(new Set(shown).size).toBe(shown.length);
			expect([...shown].sort()).toEqual(["bitbucket", "email", "github", "gitlab", "google"]);
		}
	});
});
