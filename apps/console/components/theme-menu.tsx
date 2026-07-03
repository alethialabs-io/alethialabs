"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { cn } from "@repo/ui/utils";

const THEMES = [
	{ value: "system", icon: Monitor, label: "System" },
	{ value: "light", icon: Sun, label: "Light" },
	{ value: "dark", icon: Moon, label: "Dark" },
] as const;

/**
 * Inline theme switcher as a single account-menu row (Vercel-style): a "Theme" label on
 * the left and a compact icon-only System / Light / Dark toggle on the trailing edge. The
 * options are plain buttons — not DropdownMenuItems — so picking one switches the theme
 * without dismissing the menu.
 */
export function InlineThemeSwitcher() {
	const { theme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);

	// Avoid a hydration mismatch on the active-theme highlight.
	useEffect(() => setMounted(true), []);

	return (
		<div className="flex items-center justify-between px-2 py-1.5">
			<span className="text-sm">Theme</span>
			<div className="flex items-center gap-0.5 rounded-md border p-0.5">
				{THEMES.map(({ value, icon: Icon, label }) => {
					const active = mounted && theme === value;
					return (
						<button
							key={value}
							type="button"
							aria-label={label}
							aria-pressed={active}
							onClick={() => setTheme(value)}
							className={cn(
								"flex h-6 w-6 items-center justify-center rounded-sm transition-colors",
								active
									? "bg-muted text-foreground"
									: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
							)}
						>
							<Icon className="h-3.5 w-3.5" />
						</button>
					);
				})}
			</div>
		</div>
	);
}
