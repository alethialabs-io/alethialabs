// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";
import { SettingsNav } from "@/components/settings/settings-nav";
import { SettingsShell } from "@/components/settings/settings-shell";

/**
 * Two-pane project settings layout. Inside a project the sidebar is the icon rail (no drill), so the
 * settings section-nav renders here in the content area — a self-contained left nav + content column.
 */
export default function ProjectSettingsLayout({
	children,
}: {
	children: ReactNode;
}) {
	return (
		<div className="flex gap-8">
			<aside className="w-44 shrink-0">
				<SettingsNav />
			</aside>
			<div className="min-w-0 flex-1">
				<SettingsShell>{children}</SettingsShell>
			</div>
		</div>
	);
}
