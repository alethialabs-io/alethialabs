"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

const THEMES = [
	{ value: "system", icon: Monitor, label: "System" },
	{ value: "light", icon: Sun, label: "Light" },
	{ value: "dark", icon: Moon, label: "Dark" },
] as const;

export function ThemeToggle() {
	const { theme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);

	useEffect(() => setMounted(true), []);

	if (!mounted) {
		return <div className="h-8 w-20" />;
	}

	return (
		<div className="inline-flex items-center gap-0.5 rounded-full border border-border/50 bg-muted/30 p-0.5">
			{THEMES.map(({ value, icon: Icon, label }) => (
				<button
					key={value}
					onClick={() => setTheme(value)}
					className={`inline-flex items-center justify-center rounded-full p-1.5 transition-colors ${
						theme === value
							? "bg-background text-foreground shadow-sm"
							: "text-muted-foreground hover:text-foreground"
					}`}
					aria-label={label}
				>
					<Icon className="h-3.5 w-3.5" />
				</button>
			))}
		</div>
	);
}
