// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";
import { SettingsShell } from "@/components/settings/settings-shell";

/** Two-pane settings layout for a project — the section nav (project-scoped) lives in the
 * sidebar drill; this is just the content column, shared with the org `~/settings`. */
export default function ProjectSettingsLayout({
	children,
}: {
	children: ReactNode;
}) {
	return <SettingsShell>{children}</SettingsShell>;
}
