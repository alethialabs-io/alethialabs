// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";

/**
 * Settings content wrapper. The section nav lives in the main dashboard sidebar,
 * which swaps to the settings nav (with a "← Dashboard" back link) while under
 * `/dashboard/settings` — Vercel-style — so this shell is just the content column.
 */
export function SettingsShell({ children }: { children: ReactNode }) {
	return <div className="min-w-0 flex-1">{children}</div>;
}
