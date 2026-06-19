// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/** Next.js server-startup hook. Runs once per app instance on the Node runtime. */
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	const { startStaleJobRecovery } = await import("@/lib/jobs/recovery");
	startStaleJobRecovery();
	// Sync the static authz registry (permissions + built-in roles) — idempotent.
	const { seedAuthz } = await import("@/lib/authz/seed");
	await seedAuthz().catch((err) => console.error("[authz] seed failed:", err));
	// Mirror the model + grants into OpenFGA when the enterprise engine is active;
	// a no-op in the community build. Runs after the registry seed so grants exist.
	const { getTupleSync } = await import("@/lib/authz/tuple-sync");
	void getTupleSync()
		.backfill()
		.catch((err) => console.error("[authz] FGA backfill failed:", err));
}
