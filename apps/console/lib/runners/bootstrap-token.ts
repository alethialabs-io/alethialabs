// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { runnerBootstrapTokens } from "@/lib/db/schema";
import { generateRunnerToken } from "@/lib/runners/auth";

/**
 * Per-VM fleet bootstrap token (E0 0b). The scaler mints one per VM at create time and injects
 * it into that VM's cloud-init (never the shared secret), so a token leaked via the Hetzner
 * metadata userdata is bounded to that one VM and dead once its TTL passes. Instance-bound +
 * reusable-within-TTL (see redeem_bootstrap_token) — restart-safe with no runner-side change.
 */
const TTL_SECONDS =
	Number.parseInt(process.env.FLEET_BOOTSTRAP_TOKEN_TTL_SECONDS ?? "3600", 10) ||
	3600;

/** Mints + records a per-VM bootstrap token; returns the plaintext for the VM cloud-init. */
export async function mintBootstrapToken(): Promise<string> {
	const { token, hash } = generateRunnerToken();
	await getServiceDb()
		.insert(runnerBootstrapTokens)
		.values({
			token_hash: hash,
			expires_at: new Date(Date.now() + TTL_SECONDS * 1000),
		});
	return token;
}

/**
 * Atomically validates + instance-binds a presented bootstrap token. `ok=false` means
 * invalid / expired / already bound to a DIFFERENT instance. `runnerId` is the currently linked
 * runner (null on first redeem).
 */
export async function redeemBootstrapToken(
	tokenHash: string,
	instanceId: string | null,
): Promise<{ ok: boolean; runnerId: string | null }> {
	const rows = await getServiceDb().execute<{
		ok: boolean;
		runner_id: string | null;
	}>(sql`select ok, runner_id from redeem_bootstrap_token(${tokenHash}, ${instanceId})`);
	const row = rows[0];
	return { ok: !!row?.ok, runnerId: row?.runner_id ?? null };
}

/** Links a redeemed token to the runner it created (self-heals a retry that lost its response). */
export async function linkBootstrapToken(
	tokenHash: string,
	runnerId: string,
): Promise<void> {
	await getServiceDb().execute(
		sql`update runner_bootstrap_tokens set runner_id = ${runnerId}::uuid where token_hash = ${tokenHash}`,
	);
}

/**
 * Deletes bootstrap-token rows well past expiry (a 1h grace beyond TTL so an in-flight boot /
 * lost-response retry always still finds its row). Best-effort, called from the scaler tick.
 */
export async function sweepBootstrapTokens(): Promise<void> {
	await getServiceDb().execute(
		sql`delete from runner_bootstrap_tokens where expires_at < now() - interval '1 hour'`,
	);
}
