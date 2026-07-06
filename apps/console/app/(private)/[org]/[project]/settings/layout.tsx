// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";
import { SettingsShell } from "@/components/settings/settings-shell";

/**
 * Project settings content shell. The section-nav (General · Access · Activity) lives in the
 * app-shell sidebar's Settings drill — which force-expands the sidebar on these routes — so this
 * layout only frames the content, mirroring the org settings layout.
 */
export default function ProjectSettingsLayout({
	children,
}: {
	children: ReactNode;
}) {
	return <SettingsShell>{children}</SettingsShell>;
}
