// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `@repo/ui/theme-toggle` (mounted by the console's account menu) highlights the stored theme only
// past hydration: the server cannot know it, so a server render that pressed a button would hydrate
// against a browser that disagrees. #6146 moved the "past hydration?" answer from a mount effect to
// `useSyncExternalStore`; these pin that the server still presses nothing and the browser does.
//
// What each one is there to catch: returning `true` from the server snapshot presses "Dark" in the
// server HTML (the first test); returning `false` from the client snapshot never presses it (the
// second).

import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "@repo/ui/theme-toggle";

vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "dark", setTheme: () => {} }) }));

describe("ThemeToggle hydration (#6146)", () => {
	it("presses no theme in the server render, even when the theme is known", () => {
		const html = renderToString(<ThemeToggle />);
		expect(html).toContain('aria-label="Dark"');
		expect(html).not.toContain('aria-pressed="true"');
	});

	it("presses the stored theme in the browser", () => {
		render(<ThemeToggle />);
		expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "false");
	});
});
