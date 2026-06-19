// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";
import { SettingsShell } from "@/components/settings/settings-shell";

/** Two-pane settings layout: section-nav + the active section page. */
export default function SettingsLayout({ children }: { children: ReactNode }) {
	return <SettingsShell>{children}</SettingsShell>;
}
