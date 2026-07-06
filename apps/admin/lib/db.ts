// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The admin DB client. This app is inherently CROSS-TENANT (staff view/answer
// every org's cases), so it keeps ONLY the service (RLS-bypass) connection — there is no
// per-owner app role here; the SUPPORT_STAFF_EMAILS allowlist behind Cloudflare Access is
// the trust boundary (see lib/auth/staff.ts). Reads the same Postgres as the console via
// ALETHIA_DATABASE_URL; the console owns the schema + migrations. The drizzle schema is
// the shared support tables (@repo/support/schema) plus the minimal organization/user
// refs the joins need (./db-schema).

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { env } from "next-runtime-env";
import postgres from "postgres";
import { z } from "zod";
import * as supportSchema from "@repo/support/schema";
import { organization, user } from "./db-schema";

const schema = { ...supportSchema, organization, user };

type Db = PostgresJsDatabase<typeof schema>;

/** Typed, validated Postgres connection config, read once and cached. */
const dbConfigSchema = z.object({
	serviceUrl: z
		.string()
		.min(1, "ALETHIA_DATABASE_URL is required (e.g. postgres://user:pass@host:5432/db)"),
	poolMax: z.coerce.number().int().positive().default(10),
	idleTimeout: z.coerce.number().int().nonnegative().default(20),
});

let cachedConfig: z.infer<typeof dbConfigSchema> | undefined;

/** Returns the validated DB config, throwing a clear error when misconfigured. */
function getDbConfig(): z.infer<typeof dbConfigSchema> {
	if (cachedConfig) return cachedConfig;
	const parsed = dbConfigSchema.safeParse({
		serviceUrl: env("ALETHIA_DATABASE_URL"),
		poolMax: env("ALETHIA_DB_POOL_MAX"),
		idleTimeout: env("ALETHIA_DB_IDLE_TIMEOUT"),
	});
	if (!parsed.success) {
		const issues = parsed.error.issues
			.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
			.join("\n");
		throw new Error(
			`Invalid database configuration:\n${issues}\nSet ALETHIA_DATABASE_URL — see .env.example.`,
		);
	}
	cachedConfig = parsed.data;
	return cachedConfig;
}

// Cache the postgres-js client + drizzle instance across HMR / module reloads.
const globalForDb = globalThis as unknown as {
	__supportAdminServiceDb?: Db;
};

/** Builds a pooler-safe postgres-js client (prepare:false → transaction-pooler compatible). */
function makeClient(url: string) {
	const cfg = getDbConfig();
	return postgres(url, {
		max: cfg.poolMax,
		idle_timeout: cfg.idleTimeout,
		prepare: false,
	});
}

/**
 * The service connection — bypasses RLS (superuser / BYPASSRLS role). Every staff read
 * and write goes through this: staff act on every org's cases, and the allowlist (not
 * RLS) is the wall.
 */
export function getServiceDb(): Db {
	if (!globalForDb.__supportAdminServiceDb) {
		globalForDb.__supportAdminServiceDb = drizzle(
			makeClient(getDbConfig().serviceUrl),
			{ schema, casing: "snake_case" },
		);
	}
	return globalForDb.__supportAdminServiceDb;
}
