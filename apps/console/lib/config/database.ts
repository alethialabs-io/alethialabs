// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { env } from "next-runtime-env";
import { z } from "zod";

/**
 * Typed, validated Postgres configuration. Read once, lazily, and cached. Two
 * connection URLs back the two-role model: the service/migration URL (bypasses
 * RLS — runner/CLI/RPC paths) and the app URL (least-privilege, RLS-enforced —
 * user-facing queries via withOwnerScope). If the app URL is unset it falls back
 * to the service URL (single-role dev), with the caveat that the RLS backstop is
 * only truly enforced when the app role lacks BYPASSRLS.
 */
const databaseConfigSchema = z.object({
	serviceUrl: z
		.string()
		.min(1, "ALETHIA_DATABASE_URL is required (e.g. postgres://user:pass@host:5432/db)"),
	appUrl: z.string().min(1),
	poolMax: z.coerce.number().int().positive().default(10),
	/** Connection idle timeout (seconds) for postgres-js. */
	idleTimeout: z.coerce.number().int().nonnegative().default(20),
});

export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;

let cached: DatabaseConfig | undefined;

/** Returns the validated DB config, throwing a clear error if misconfigured. */
export function getDatabaseConfig(): DatabaseConfig {
	if (cached) return cached;

	const serviceUrl = env("ALETHIA_DATABASE_URL");

	const parsed = databaseConfigSchema.safeParse({
		serviceUrl,
		// App (RLS-enforced) connection; default to the service URL if unset.
		appUrl: env("ALETHIA_APP_DATABASE_URL") || serviceUrl,
		poolMax: env("ALETHIA_DB_POOL_MAX"),
		idleTimeout: env("ALETHIA_DB_IDLE_TIMEOUT"),
	});

	if (!parsed.success) {
		const issues = parsed.error.issues
			.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
			.join("\n");
		throw new Error(
			`Invalid database configuration:\n${issues}\n` +
				`Set ALETHIA_DATABASE_URL (and optionally ALETHIA_APP_DATABASE_URL) — see .env.example.`,
		);
	}

	cached = parsed.data;
	return cached;
}
