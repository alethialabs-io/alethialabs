// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W4: encrypt-at-rest for `secret`-typed add-on knobs. A secret field's value is stored in
// project_addons.values as an EncryptedSecret envelope (never plaintext — see the north-star's
// "no plaintext JSONB"), using the same AES-256-GCM keyring that protects connector/alert secrets
// (lib/crypto/secrets.ts).
//
// W4.5 (#640): the value is now NEVER decrypted into the deploy snapshot or the Helm values.
// `resolveAddOnInstall` strips secret fields and emits a Secret REF; the runner fetches the
// plaintext at execution time over the authenticated job channel (`/api/jobs/[id]/addon-secrets`,
// the git-token pattern) and seeds a k8s Secret in-cluster, which the chart consumes via the
// def's `secretValues` wiring (existingSecret / secretKeyRef).

import { generateKeyPairSync, randomBytes } from "node:crypto";

import { hashSync } from "bcryptjs";

import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";
import type { AddOnDef } from "@/lib/addons/types";
import type { EncryptedSecret } from "@/types/jsonb.types";

/** Keys of an add-on's secret-typed fields (type === "secret", or the convenience `secret` flag). */
export function secretFieldKeys(def: AddOnDef): string[] {
	return def.fields
		.filter((f) => f.type === "secret" || f.secret === true)
		.map((f) => f.key);
}

/** Whether a stored value counts as a PRESENT secret: an EncryptedSecret envelope, or a
 * non-empty pre-W4 plaintext string (tolerated for old rows — still diverted to the Secret,
 * never to the manifest). */
export function hasStoredSecret(v: unknown): boolean {
	return isEncryptedSecret(v) || (typeof v === "string" && v.length > 0);
}

/**
 * Strip every secret-typed field out of a stored values object (W4.5), so the Zod schema
 * falls back to the field's default and `toValues` can never see a credential — neither an
 * envelope nor a legacy plaintext. Returns a new object.
 */
export function stripAddonSecrets(
	def: AddOnDef,
	values: Record<string, unknown>,
): Record<string, unknown> {
	const keys = secretFieldKeys(def);
	if (keys.length === 0) return values;
	const out = { ...values };
	for (const key of keys) delete out[key];
	return out;
}

/** Structural check for an EncryptedSecret envelope (iv/tag/data), so we never re-encrypt or try
 * to decrypt a plaintext value. */
function isEncryptedSecret(v: unknown): v is EncryptedSecret {
	return (
		typeof v === "object" &&
		v !== null &&
		"iv" in v &&
		"tag" in v &&
		"data" in v
	);
}

/**
 * Encrypt each secret-typed field's plaintext value into an EncryptedSecret before persistence.
 * A missing/empty secret is dropped (no blank envelope); an already-encrypted value is left as-is
 * (idempotent re-save); non-secret fields are untouched. Returns a new object.
 */
export function encryptAddonSecrets(
	def: AddOnDef,
	values: Record<string, unknown>,
): Record<string, unknown> {
	const keys = secretFieldKeys(def);
	if (keys.length === 0) return values;
	const out = { ...values };
	for (const key of keys) {
		const v = out[key];
		if (typeof v === "string" && v.length > 0) {
			out[key] = encryptSecret({ [key]: v });
		} else if (!isEncryptedSecret(v)) {
			// empty / absent / non-string → don't persist a blank secret
			delete out[key];
		}
	}
	return out;
}

/** A redacted secret marker for the CLIENT read: envelope-SHAPED (so `hasStoredSecret` still reads
 * it as "set") but carrying no ciphertext. The real envelope never leaves the server. */
const REDACTED_SECRET: EncryptedSecret = { v: 0, iv: "", tag: "", data: "" };

/**
 * Replace every stored secret with a redacted marker for the client read (getProjectAddons), so the
 * ciphertext never reaches the browser while the field keeps its set/unset signal (the marker is
 * still envelope-shaped). An unset secret is left absent. Returns a new object.
 */
export function redactAddonSecrets(
	def: AddOnDef,
	values: Record<string, unknown>,
): Record<string, unknown> {
	const keys = secretFieldKeys(def);
	if (keys.length === 0) return values;
	const out = { ...values };
	for (const key of keys) {
		if (hasStoredSecret(out[key])) out[key] = { ...REDACTED_SECRET };
		else delete out[key];
	}
	return out;
}

/**
 * Build the values to persist on a reconfigure, PRESERVING any secret the user left untouched. For
 * each secret key: a new non-empty plaintext is encrypted; an empty/absent value carries forward the
 * existing stored envelope (so re-saving other knobs never wipes a set secret — the enable action
 * replaces the whole values object, and `configSchema` types a secret as a string, so the client
 * cannot round-trip the envelope itself); a key with neither stays unset. Non-secret knobs come
 * straight from `incoming`. Replaces the plain `encryptAddonSecrets` at the reconfigure call-site.
 */
export function mergeAddonSecrets(
	def: AddOnDef,
	incoming: Record<string, unknown>,
	existing: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
	const keys = secretFieldKeys(def);
	if (keys.length === 0) return { ...incoming };
	const out = { ...incoming };
	for (const key of keys) {
		const v = out[key];
		if (typeof v === "string" && v.length > 0) {
			out[key] = encryptSecret({ [key]: v });
		} else {
			const prior = existing?.[key];
			if (isEncryptedSecret(prior)) out[key] = prior;
			else delete out[key];
		}
	}
	return out;
}

/**
 * A URL-safe random credential of `bytes` entropy, for `generateSecrets` implementations.
 *
 * base64url rather than a hand-rolled alphabet loop: no modulo bias, and no alphabet to get
 * subtly wrong. 24 bytes is 192 bits, well past anything a chart's own `randAlphaNum 16` gives.
 */
export function randomCredential(bytes = 24): string {
	return randomBytes(bytes).toString("base64url");
}

/**
 * A fresh 2048-bit RSA private key in PKCS#1 PEM, for a chart that would otherwise generate an
 * EPHEMERAL keypair at render time.
 *
 * Only the KEY is minted, deliberately — harbor's `core.secretName` Secret is mounted
 * `subPath: tls.key`, so the certificate half is never read, and generating a self-signed X.509
 * would mean an ASN.1 encoder that node's stdlib does not provide (#2823).
 */
export function randomRsaPrivateKeyPem(): string {
	return generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs1", format: "pem" },
		publicKeyEncoding: { type: "pkcs1", format: "pem" },
	}).privateKey;
}

/**
 * One htpasswd line, `user:<bcrypt hash>`, for a registry that authenticates against an htpasswd
 * file.
 *
 * BCRYPT IS NOT A PREFERENCE. docker distribution's htpasswd access controller accepts bcrypt
 * only, so the apr1/MD5 form in harbor's own values.yaml example would be rejected. Helm's
 * `htpasswd` template function produces bcrypt for the same reason — and re-salts on every call,
 * which is exactly the render non-determinism this replaces.
 *
 * The cost is `hashSync` at a work factor: ~50-100ms, once, at enable time only.
 */
export function htpasswdLine(username: string, password: string): string {
	return `${username}:${hashSync(password, 10)}`;
}

/**
 * Mint the secret knobs an add-on declares as auto-generated and the user left unset, encrypting
 * each before it is persisted (#2822, #2823).
 *
 * WHY THIS EXISTS. A chart that generates its own credential does so at RENDER time. ArgoCD
 * re-renders on every reconcile, so the Secret never matches the live one — the Application sits
 * permanently OutOfSync, selfHeal rewrites it every pass, and any chart that stamps a
 * `checksum/secret` annotation onto its pod template rolls its pods forever. Worse, the rotating
 * value is often load-bearing: harbor's token-signing keypair signs the registry's auth tokens, so
 * rotating it silently invalidates every `docker pull` credential the registry ever issued.
 *
 * So for these add-ons a blank field must not mean "let the chart generate one". Minting the value
 * here makes `hasStoredSecret` true, which makes `resolveAddOnInstall` emit a secretRef, which makes
 * the def's `secretValues` wire the chart at an `existingSecret` — and the render stops moving.
 *
 * Runs AFTER `mergeAddonSecrets`, on its output, so:
 *   - a value the user supplied wins (it is already present, so nothing is minted for that key);
 *   - a value carried forward from a previous save wins for the same reason — a reconfigure of
 *     unrelated knobs can never rotate a live credential;
 *   - and only a genuinely unset key is filled.
 *
 * A generator that returns a key which is already set, or an empty string, is ignored rather than
 * trusted — the invariant this function actually owns is "never overwrite a stored secret", and it
 * must not depend on every definition getting that right.
 *
 * Returns a new object. Server-side only (it encrypts).
 */
export function generateAddonSecrets(
	def: AddOnDef,
	values: Record<string, unknown>,
): Record<string, unknown> {
	if (!def.generateSecrets) return values;
	const keys = secretFieldKeys(def);
	if (keys.length === 0) return values;
	const present = new Set(keys.filter((k) => hasStoredSecret(values[k])));
	const minted = def.generateSecrets(present);
	const out = { ...values };
	for (const [key, plaintext] of Object.entries(minted)) {
		// Only declared SECRET fields — a generator cannot smuggle a value into a plain knob,
		// which would land in the deploy snapshot as plaintext.
		if (!keys.includes(key)) continue;
		if (present.has(key)) continue;
		if (typeof plaintext !== "string" || plaintext.length === 0) continue;
		out[key] = encryptSecret({ [key]: plaintext });
	}
	return out;
}

/**
 * Decrypt each secret-typed field's envelope back to plaintext. W4.5: this NEVER runs at
 * snapshot-assembly time anymore — its only caller is the runner-facing
 * `/api/jobs/[id]/addon-secrets` route, which hands the values to the job's runner over the
 * authenticated channel (the git-token pattern) so it can seed the in-cluster Secret.
 * Tolerant of pre-W4 rows (a plaintext or absent value is left as-is). Returns a new object.
 * Server-side only.
 */
export function decryptAddonSecrets(
	def: AddOnDef,
	values: Record<string, unknown>,
): Record<string, unknown> {
	const keys = secretFieldKeys(def);
	if (keys.length === 0) return values;
	const out = { ...values };
	for (const key of keys) {
		const v = out[key];
		if (isEncryptedSecret(v)) {
			out[key] = decryptSecret(v)[key] ?? "";
		}
	}
	return out;
}
