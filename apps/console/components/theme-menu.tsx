"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ThemeToggle } from "@repo/ui/theme-toggle";

/**
 * Inline theme switcher as a single account-menu row (Vercel-style): a "Theme" label on
 * the left and a compact icon-only System / Light / Dark toggle on the trailing edge. The
 * options are plain buttons — not DropdownMenuItems — so picking one switches the theme
 * without dismissing the menu.
 *
 * The control itself is `@repo/ui/theme-toggle`, shared with the marketing header so the
 * two cannot drift apart.
 */
export function InlineThemeSwitcher() {
	return (
		<div className="flex items-center justify-between px-2 py-1.5">
			<span className="text-sm">Theme</span>
			<ThemeToggle />
		</div>
	);
}
