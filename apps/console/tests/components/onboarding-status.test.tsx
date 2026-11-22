// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The cards /onboarding shows instead of the form (WIZ-W6, A-10). "Setup incomplete" used to be a
// dead end with no button and no address; every card now says what happened, offers a retry that
// re-asks the server, and names the support address — and none offers a payment or a trial.

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// The shell's sign-in line and footer are its own suite's subject.
vi.mock("@/components/auth/auth-shell", () => ({
	AuthShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	AuthCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { OnboardingStatus, type OnboardingStatusKind } from "@/app/(public)/onboarding/onboarding-status";

const KINDS: readonly OnboardingStatusKind[] = ["no-org", "unknown", "in-flight"];

describe("OnboardingStatus", () => {
	it.each(KINDS)("%s: says what happened, offers a retry and the support address", (kind) => {
		render(<OnboardingStatus kind={kind} retryHref="/onboarding?next=%2Fstart" />);

		expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
		const retry = screen.getByRole("link", { name: /try again|check again/i });
		expect(retry).toHaveAttribute("href", "/onboarding?next=%2Fstart");
		expect(screen.getByRole("link", { name: "support@alethialabs.io" })).toHaveAttribute(
			"href",
			"mailto:support@alethialabs.io",
		);
		expect(screen.queryByText(/trial|pay now|subscribe/i)).toBeNull();
	});

	it("names the setup failure for what it is", () => {
		render(<OnboardingStatus kind="no-org" retryHref="/onboarding" />);
		expect(screen.getByText("Setup incomplete")).toBeInTheDocument();
	});

	it("tells a person with an unconfirmed payment that it is being confirmed", () => {
		render(<OnboardingStatus kind="in-flight" retryHref="/onboarding" />);
		expect(screen.getByRole("heading", { name: /still being confirmed/i })).toBeInTheDocument();
	});
});
