// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The upgrade CTAs that LEAVE the page are links, and say so (#5413).
//
// `UpsellActions` renders Contact Sales and Learn more as `<a href target="_blank">` through
// base-ui's Button with `nativeButton={false}`, and base-ui stamps `role="button"` on any non-native
// render. So every Enterprise upgrade dialog (Teams, Roles, Access, SSO) offered a "button" that
// navigated to another site, and the release gate's RBAC flow could not find
// `getByRole("link", { name: /contact sales/i })` in three of its dialogs (run 37063039802).
// "Upgrade to Pro" opens the upgrade sheet in place, so it is — and must stay — a button.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/org/upgrade-sheet-provider", () => ({
	useUpgradeSheet: () => ({ openUpgrade: vi.fn() }),
}));

import { UpsellActions } from "@/components/settings/upgrade/upsell-actions";

describe("UpsellActions", () => {
	it("an Enterprise feature's Contact Sales and Learn more are links, not buttons", () => {
		render(<UpsellActions feature="teams" />);
		const sales = screen.getByRole("link", { name: "Contact Sales" });
		expect(sales.getAttribute("href")).toMatch(/\/contact\/sales$/);
		expect(screen.getByRole("link", { name: "Learn more" })).toHaveAttribute("href");
		expect(screen.queryByRole("button", { name: "Contact Sales" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Learn more" })).toBeNull();
	});

	it("a Pro feature's upgrade opens the sheet in place, so it stays a button", () => {
		render(<UpsellActions feature="invite" />);
		expect(screen.getByRole("button", { name: /^Upgrade to / })).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: /^Upgrade to / })).toBeNull();
		expect(screen.getByRole("link", { name: "Learn more" })).toHaveAttribute("href");
	});
});
