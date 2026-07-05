// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";

/**
 * Support content wrapper. Mirrors {@link SettingsShell}: the Support section lives in
 * the app sidebar, so this shell is just the thin, centered content column shared by
 * the support landing, submit, abuse, and case surfaces.
 */
export function SupportShell({ children }: { children: ReactNode }) {
	return (
		<div className="mx-auto w-full min-w-0 max-w-[1200px]">{children}</div>
	);
}
