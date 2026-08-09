"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { cn } from "./utils";

const THEMES = [
	{ value: "system", icon: Monitor, label: "System" },
	{ value: "light", icon: Sun, label: "Light" },
	{ value: "dark", icon: Moon, label: "Dark" },
] as const;

interface ThemeToggleProps {
	className?: string;
	/** Render without the surrounding hairline box (for dense chrome like a navbar). */
	bare?: boolean;
}

/**
 * Compact System / Light / Dark segmented control.
 *
 * Shared so the console account menu and the marketing header cannot drift; it
 * is also the only reason a visitor can reach light mode on the marketing site
 * at all, which was hard-locked to dark by `forcedTheme` until now.
 *
 * Every app mounting this must set `enableSystem` on its `ThemeProvider` — the
 * console offered "System" for months while its provider had `enableSystem`
 * turned off, so picking it silently did nothing.
 */
export function ThemeToggle({ className, bare }: ThemeToggleProps) {
	const { theme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);

	// The server cannot know the stored theme; highlight only after hydration.
	useEffect(() => setMounted(true), []);

	return (
		<div
			className={cn(
				"flex items-center gap-0.5",
				!bare && "rounded-md border p-0.5",
				className,
			)}
		>
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
							"flex h-6 w-6 items-center justify-center rounded-sm transition-colors duration-[var(--dur-1)] ease-[var(--ease)]",
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
	);
}
