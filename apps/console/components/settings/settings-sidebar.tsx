"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { SettingsNav } from "./settings-nav";

/**
 * The settings-mode sidebar body. When the user is anywhere under
 * `/dashboard/settings`, the main dashboard sidebar swaps its nav for this one
 * (Vercel-style): a "← Dashboard" back link above the flat settings section nav.
 * Rendered inside the layout's existing `<aside>` chrome, so it inherits the
 * sidebar's width, scroll, and footer.
 */
export function SettingsSidebar() {
	return (
		<div className="space-y-4">
			<Link
				href="/dashboard"
				className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
			>
				<ArrowLeft className="h-4 w-4 shrink-0" />
				<span>Dashboard</span>
			</Link>
			<div className="px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
				Settings
			</div>
			<SettingsNav />
		</div>
	);
}
