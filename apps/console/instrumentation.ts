// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/** Next.js server-startup hook. Runs once per app instance on the Node runtime. */
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	const { startStaleJobRecovery } = await import("@/lib/jobs/recovery");
	startStaleJobRecovery();
}
