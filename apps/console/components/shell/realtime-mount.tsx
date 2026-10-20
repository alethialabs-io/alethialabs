// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

/**
 * The single mount point for the org's real-time stream (ADR 0005 D3). An empty slot today:
 * #6113 places it in `AppShell` so the bus (#6115) is wired in by editing THIS file only, and the
 * shell lane (#6114) and the bus never co-edit `app-shell.tsx` (stress test R10).
 */
export function RealtimeMount(): null {
	return null;
}
