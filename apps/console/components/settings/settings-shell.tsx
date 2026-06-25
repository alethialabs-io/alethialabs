// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";

/**
 * Settings content wrapper. The section nav lives in the app sidebar, which drills
 * into the settings sub-nav (with a back link to the overview) while under
 * `/{org}/~/settings` — Vercel-style — so this shell is just the content column.
 */
export function SettingsShell({ children }: { children: ReactNode }) {
	return <div className="min-w-0 flex-1">{children}</div>;
}
