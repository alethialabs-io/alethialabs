// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Memoized RSA-2048 test keys.
//
// WHY THIS EXISTS (#1475, the sibling of #1402). The OIDC issuer + runner-token tests each minted a
// FRESH RSA-2048 keypair inside a per-test helper, so a 4-test file paid four keygens. Measured in
// isolation on an idle box those tests already cost ~4.3-4.4s against vitest's 5000ms default — a
// ~600ms margin — and they timed out in a full-suite run.
//
// RSA keygen is a probabilistic prime search: its cost is a distribution with a long tail, not a
// stable constant. That is exactly what makes this present as a FLAKE rather than a steady failure —
// the mean fits the budget, the tail does not. Raising the timeout alone would hide it while still
// paying the cost on every run; caching removes the cost.
//
// The keys are throwaway material generated at runtime, never secrets — but they ARE real 2048-bit
// keys, so the crypto under test is the same crypto that runs in production. This trades no fidelity,
// only repetition.
//
// SCOPE: memoization is per module registry, which vitest gives each test FILE — so this collapses
// N keygens per file to one per slot, not one globally. That is the whole win here and it needs no
// globalSetup and no change to test isolation.

import { generateKeyPairSync } from "node:crypto";

/** A generated keypair in the two encodings the tests use. */
export interface TestRsaKey {
	/** PKCS8 PEM — what `jose.importPKCS8` and `createPublicKey` take. */
	pem: string;
	/** base64(PKCS8 PEM) — the `ALETHIA_OIDC_SIGNING_KEY` env encoding. */
	b64: string;
}

const pool = new Map<number, TestRsaKey>();

/**
 * A stable RSA-2048 test key, generated once per slot per test file.
 *
 * `slot` exists for the tests that need two DISTINCT keys at the same time — the issuer's
 * key-rotation suite publishes a primary plus an outgoing previous key and asserts the JWKS carries
 * both, which a single shared key would silently collapse to one. Same slot ⇒ same key; different
 * slots ⇒ different keys.
 */
export function testRsaKey(slot = 0): TestRsaKey {
	const cached = pool.get(slot);
	if (cached) return cached;
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
	const key: TestRsaKey = { pem, b64: Buffer.from(pem, "utf8").toString("base64") };
	pool.set(slot, key);
	return key;
}
