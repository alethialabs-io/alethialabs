"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

/**
 * Compact light/dark toggle for the site header. Renders a stable icon until
 * mounted so the button never mismatches the server-rendered markup, then
 * reflects the resolved theme. Grayscale, currentColor, per the brand.
 */
export function ThemeToggle() {
	const { resolvedTheme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);

	const isDark = mounted && resolvedTheme === "dark";
	return (
		<button
			type="button"
			aria-label="Toggle color theme"
			onClick={() => setTheme(isDark ? "light" : "dark")}
			className="ah-hide-sm"
			style={{
				display: "grid",
				placeItems: "center",
				width: 32,
				height: 32,
				borderRadius: "var(--radius-sm)",
				border: "1px solid var(--border)",
				background: "transparent",
				color: "var(--text-tertiary)",
				cursor: "pointer",
				transition: "color .12s, border-color .12s",
			}}
		>
			{isDark ? <Sun size={15} strokeWidth={1.7} /> : <Moon size={15} strokeWidth={1.7} />}
		</button>
	);
}
