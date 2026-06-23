"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { Monitor, Moon, Sun, SunMoon } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

const THEMES = [
	{ value: "system", icon: Monitor, label: "System" },
	{ value: "light", icon: Sun, label: "Light" },
	{ value: "dark", icon: Moon, label: "Dark" },
] as const;

/**
 * Theme switcher as a hover submenu inside the profile dropdown. The trigger
 * reads "Theme"; hovering reveals System / Light / Dark with the active one marked.
 */
export function ThemeMenu() {
	const { theme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);

	// Avoid a hydration mismatch on the active-theme indicator.
	useEffect(() => setMounted(true), []);

	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger className="gap-2">
				<SunMoon className="h-4 w-4 text-muted-foreground" />
				Theme
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent>
				<DropdownMenuRadioGroup
					value={mounted ? theme : undefined}
					onValueChange={setTheme}
				>
					{THEMES.map(({ value, icon: Icon, label }) => (
						<DropdownMenuRadioItem key={value} value={value} className="gap-2">
							<Icon className="h-4 w-4 text-muted-foreground" />
							{label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}
