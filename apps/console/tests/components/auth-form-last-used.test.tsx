// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The "Last used" lead on the sign-in step, asserted through the accessible name rather
// than the pixels.
//
// This exists because looking at it in a browser was not enough twice over. The mark's
// text joins the button's accessible name unless something stops it, and the first
// version announced "GitHubLast used" — the name concatenates descendant text and knows
// nothing about `ml-1`. The fix (aria-hidden pill + an explicit aria-label) then could
// not be confirmed in the browser at all, because the sandbox box kept serving a bundle
// built before the edit: its JS contained "Last used" and not "(last used)". A rendered
// page is a claim about one build at one moment; this runs against the source every time.
//
// jsdom gives a real localStorage, so the store is seeded rather than mocked — the same
// path a returning user takes. Reset needs BOTH storage and setState, because the zustand
// singleton is module-scoped and survives between tests.

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(""),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/auth/client", () => ({
	authClient: {
		signIn: { social: vi.fn(), emailOtp: vi.fn() },
		emailOtp: { sendVerificationOtp: vi.fn() },
	},
}));
vi.mock("@/app/server/actions/auth", () => ({ requestEmailCode: vi.fn() }));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));

import { AuthForm } from "@/components/auth/auth-form";
import { useAuthPrefsStore } from "@/lib/stores/use-auth-prefs-store";

beforeEach(() => {
	localStorage.clear();
	useAuthPrefsStore.setState({ lastMethod: null, lastEmail: null });
});

describe("AuthForm — the last-used mark", () => {
	it("marks nothing on a browser that has never signed in", () => {
		render(<AuthForm mode="login" />);

		// The plain name, with no mark appended anywhere.
		expect(screen.getByRole("button", { name: "GitHub" })).toBeTruthy();
		expect(screen.queryByText("Last used")).toBeNull();
	});

	it("names the remembered provider 'Continue with <Provider> (last used)', not 'GitHubLast used'", () => {
		useAuthPrefsStore.setState({ lastMethod: "github", lastEmail: null });
		render(<AuthForm mode="login" />);

		// The exact string is the point: an accessible name assembled from the badge's
		// own text ran the two words together, which is what this asserts against.
		const github = screen.getByRole("button", { name: "Continue with GitHub (last used)" });
		expect(github).toBeTruthy();

		// The visible badge must not ALSO reach the name, or it comes back doubled.
		const badge = github.querySelector(".vx-badge-mono");
		expect(badge?.textContent).toBe("Last used");
		expect(badge?.getAttribute("aria-hidden")).toBe("true");
		// Out of the label's flow: positioned on the button's edge, so it cannot push the
		// label past the border the way the inline pill did on the three-up row.
		expect(badge?.className).toContain("absolute");
	});

	// This one found a real defect rather than confirming one: GitLab and Bitbucket render
	// an <img> with a real `alt` beside their text label, so their buttons announced
	// "GitLabGitLab" and "BitbucketBitbucket". Two of four tiles said their own name twice
	// and nothing objected. The icons are decorative in this context now; the exact names
	// below are what keeps them that way.
	it("leaves every other tile's name untouched, and unduplicated", () => {
		useAuthPrefsStore.setState({ lastMethod: "github", lastEmail: null });
		render(<AuthForm mode="login" />);

		for (const name of ["Google", "GitLab", "Bitbucket"]) {
			expect(screen.getByRole("button", { name })).toBeTruthy();
		}
	});

	it("marks the email path when that is what was used last", () => {
		useAuthPrefsStore.setState({ lastMethod: "email", lastEmail: "bob@x.com" });
		render(<AuthForm mode="login" />);

		// The e2e fixtures select this control by /continue with email/i and require it to
		// resolve to exactly one node on this step — so leading with it must not fork it in two.
		const matches = screen.getAllByRole("button", { name: /continue with email/i });
		expect(matches).toHaveLength(1);
		expect(matches[0]?.getAttribute("aria-label")).toBe("Continue with email (last used)");
		expect(matches[0]?.querySelector(".vx-badge-mono")?.getAttribute("aria-hidden")).toBe(
			"true",
		);
		// Every provider still renders, under its plain name.
		for (const name of ["GitHub", "Google", "GitLab", "Bitbucket"]) {
			expect(screen.getByRole("button", { name })).toBeTruthy();
		}
	});

	it("leads with the remembered provider and keeps the other three in their order", () => {
		useAuthPrefsStore.setState({ lastMethod: "bitbucket", lastEmail: null });
		render(<AuthForm mode="login" />);

		// The remembered method is the first control on the step, then the rest in the
		// form's fixed order. The pure arrangement is pinned in sign-in-methods.test.ts;
		// this checks the form actually renders it.
		const names = screen
			.getAllByRole("button")
			.map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "")
			.filter((n) => /github|google|gitlab|bitbucket/i.test(n));

		expect(names).toHaveLength(4);
		expect(names[0]).toBe("Continue with Bitbucket (last used)");
		expect(names[1]).toMatch(/^github$/i);
		expect(names[2]).toMatch(/^google$/i);
		expect(names[3]).toMatch(/^gitlab$/i);
	});

	it("keeps today's order when nothing is remembered", () => {
		render(<AuthForm mode="login" />);

		const names = screen
			.getAllByRole("button")
			.map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "")
			.filter((n) => /github|google|gitlab|bitbucket/i.test(n));

		expect(names).toEqual(["GitHub", "Google", "GitLab", "Bitbucket"]);
	});
});
