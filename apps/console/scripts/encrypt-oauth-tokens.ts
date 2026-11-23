// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Brings every linked account's stored OAuth tokens (`account.access_token`, `refresh_token`,
// `id_token`) to the encrypted form under the ACTIVE credential key (lib/auth/oauth-token-crypto.ts):
// plaintext rows written before encryption are sealed, rows sealed under a retired key are re-sealed,
// and rows already under the active key are skipped.
//
// SAFE TO RE-RUN: a second run changes 0 rows. SAFE WHILE THE APP SERVES: each row is written with a
// compare-and-set on the three values it read, so a token the app refreshed in the meantime (already
// sealed by the app) is never overwritten — that row is counted as `raced` and the next run settles it.
// Run it AFTER the release that seals tokens is live: until then, an instance that predates it would
// read a sealed token as the token itself.
//
// NEVER prints a token or key material — only row ids and counts.
//
// `db:reencrypt` (scripts/reencrypt-secrets.ts) runs this same pass alongside every other credential
// ciphertext, so a key rotation re-seals these tokens too; this entry point runs it on its own.
//
// Run: pnpm -C apps/console exec tsx scripts/encrypt-oauth-tokens.ts
//      (needs ALETHIA_DATABASE_URL and the ALETHIA_CRED_ENCRYPTION_KEY keyring; batch size via
//      OAUTH_TOKEN_BATCH, default 500). Exits non-zero if any row could not be processed.

import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { resealOAuthToken } from "@/lib/auth/oauth-token-crypto";
import { getActiveKid, isCredEncryptionConfigured } from "@/lib/crypto/secrets";

/** One `account` row's stored token values. */
export interface AccountTokenRow {
	id: string;
	access_token: string | null;
	refresh_token: string | null;
	id_token: string | null;
}

/** Tally of one pass over the `account` table. */
export interface EncryptCounts {
	/** Rows examined (that held at least one token). */
	scanned: number;
	/** Rows rewritten. */
	changed: number;
	/** Rows already fully sealed under the active key. */
	skipped: number;
	/** Rows the app changed between the read and the write; left for the next run. */
	raced: number;
	/** Rows holding a sealed value that could not be decrypted; left untouched. */
	failed: number;
}

/**
 * The sealed values for one row, or null when every token is already sealed under the active key.
 * Throws when a sealed value cannot be decrypted, so the caller leaves that row untouched.
 */
export function planRow(row: AccountTokenRow): AccountTokenRow | null {
	const access = resealOAuthToken(row.access_token);
	const refresh = resealOAuthToken(row.refresh_token);
	const id = resealOAuthToken(row.id_token);
	if (!access.changed && !refresh.changed && !id.changed) return null;
	return { id: row.id, access_token: access.value, refresh_token: refresh.value, id_token: id.value };
}

/** Minimal typed handle for the postgres-js client. */
type Sql = ReturnType<typeof postgres>;

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** Seals every account row's tokens, batched by id (keyset pagination, so a re-run resumes). */
export async function encryptAccountTokens(sql: Sql, batch: number): Promise<EncryptCounts> {
	const counts: EncryptCounts = { scanned: 0, changed: 0, skipped: 0, raced: 0, failed: 0 };
	let cursor = ZERO_UUID;
	for (;;) {
		const rows = await sql<AccountTokenRow[]>`
			select id, access_token, refresh_token, id_token from account
			 where id > ${cursor}
			   and (access_token is not null or refresh_token is not null or id_token is not null)
			 order by id limit ${batch}`;
		if (rows.length === 0) break;
		for (const row of rows) {
			cursor = row.id;
			counts.scanned++;
			let next: AccountTokenRow | null;
			try {
				next = planRow(row);
			} catch {
				counts.failed++;
				console.warn(`  ! account ${row.id}: a sealed token could not be decrypted (skipped)`);
				continue;
			}
			if (next === null) {
				counts.skipped++;
				continue;
			}
			const written = await sql`
				update account
				   set access_token = ${next.access_token},
				       refresh_token = ${next.refresh_token},
				       id_token = ${next.id_token}
				 where id = ${row.id}
				   and access_token is not distinct from ${row.access_token}
				   and refresh_token is not distinct from ${row.refresh_token}
				   and id_token is not distinct from ${row.id_token}`;
			if (written.count === 1) counts.changed++;
			else counts.raced++;
		}
		if (rows.length < batch) break;
	}
	return counts;
}

/** Runs the pass against ALETHIA_DATABASE_URL and prints the tally. Exits non-zero on any failure. */
async function main(): Promise<void> {
	const url = process.env.ALETHIA_DATABASE_URL;
	if (!url) {
		console.error("✗ ALETHIA_DATABASE_URL is not set (see .env.example).");
		process.exit(1);
	}
	if (!isCredEncryptionConfigured()) {
		console.error("✗ ALETHIA_CRED_ENCRYPTION_KEY is not set/valid — nothing to encrypt under.");
		process.exit(1);
	}
	const batch = Number(process.env.OAUTH_TOKEN_BATCH || "500") || 500;
	console.log(`→ encrypting account OAuth tokens under active kid "${getActiveKid()}" (batch ${batch})…`);
	const sql = postgres(url, { max: 1, onnotice: () => {} });
	try {
		const c = await encryptAccountTokens(sql, batch);
		console.log(
			`  account: scanned ${c.scanned}, changed ${c.changed}, skipped ${c.skipped}, ` +
				`raced ${c.raced}, failed ${c.failed}`,
		);
		await sql.end();
		if (c.failed > 0) {
			console.error(`✗ ${c.failed} row(s) could not be decrypted (see warnings above).`);
			process.exit(1);
		}
		if (c.raced > 0) console.log("  (raced rows changed under the app; run again to settle them)");
		console.log("✓ account OAuth tokens encrypted");
		process.exit(0);
	} catch (err) {
		console.error("\n✗ encryption pass failed:\n");
		console.error(err instanceof Error ? err.message : "unknown error");
		await sql.end({ timeout: 1 }).catch(() => {});
		process.exit(1);
	}
}

// Only run the DB pass when invoked directly, not when a test imports the functions above.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	void main();
}
