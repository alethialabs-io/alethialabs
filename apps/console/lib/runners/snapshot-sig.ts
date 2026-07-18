// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Authenticity for a job's config_snapshot (Phase A). The snapshot is a frozen, denormalized aggregate
// the runner provisions from (in the managed model it then assumes customer cloud roles), and it lives
// as plaintext JSONB — a tampered row isn't otherwise detectable. This HMAC-signs it at ENQUEUE (the
// key stays in the app, never the DB, so a DB-only attacker can't forge a signature) and the console
// re-verifies at CLAIM before serving the snapshot to the runner. Symmetric HMAC is enough because the
// console is both signer and verifier; the *output* proof (what customers verify) is the ed25519
// receipt in packages/core/verify. Distinct from `configuration_hash`, which is a plan→apply integrity
// tag, not authenticity.

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Deterministic JSON with recursively sorted object keys, so sign and verify agree regardless of
 * key order — Postgres jsonb reorders keys on storage, so a plain JSON.stringify of the read-back
 * value would not be stable. Arrays keep their order (semantically significant).
 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.entries(value)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries
		.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
		.join(",")}}`;
}

/** The signing key, or null when unset — in which case signing is OFF (sig null, verify a no-op),
 *  so the feature can roll out without a hard dependency and legacy jobs keep claiming. */
function key(): string | null {
	return process.env.ALETHIA_SNAPSHOT_HMAC_KEY || null;
}

/** HMAC-SHA256 (hex) of the canonical snapshot, or null when no key is configured. */
export function signSnapshot(snapshot: unknown): string | null {
	const k = key();
	if (!k) return null;
	return createHmac("sha256", k).update(canonicalJson(snapshot)).digest("hex");
}

/**
 * True when `sig` is a valid signature of `snapshot` (timing-safe). Also true when signing is off
 * (no key) or the row predates signing (`sig` null) — back-compat: an unsigned job is not rejected,
 * only a job whose stored signature no longer matches its snapshot (tampering) is.
 */
export function verifySnapshot(snapshot: unknown, sig: string | null): boolean {
	if (!key() || sig === null) return true;
	const expected = signSnapshot(snapshot);
	if (expected === null) return true;
	const a = Buffer.from(sig, "hex");
	const b = Buffer.from(expected, "hex");
	return a.length === b.length && timingSafeEqual(a, b);
}
