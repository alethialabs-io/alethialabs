// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W4: encrypt-at-rest for `secret`-typed add-on knobs. A secret field's value is stored in
// project_addons.values as an EncryptedSecret envelope (never plaintext — see the north-star's
// "no plaintext JSONB"), using the same AES-256-GCM keyring that protects connector/alert secrets
// (lib/crypto/secrets.ts). It is decrypted server-side ONLY when assembling the deploy snapshot.
//
// NOTE (W4.5 follow-up): the decrypted value is currently merged into the Helm values, so it still
// lands in the ArgoCD Application manifest. Diverting it to a k8s Secret + the chart's
// `existingSecret` (reusing the W3 ExternalSecret shape) is the deferred fuller fix.

import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";
import type { AddOnDef } from "@/lib/addons/types";
import type { EncryptedSecret } from "@/types/jsonb.types";

/** Keys of an add-on's secret-typed fields (type === "secret", or the convenience `secret` flag). */
function secretFieldKeys(def: AddOnDef): string[] {
	return def.fields
		.filter((f) => f.type === "secret" || f.secret === true)
		.map((f) => f.key);
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

/**
 * Decrypt each secret-typed field's envelope back to its plaintext, so the add-on's Zod
 * `configSchema` validates it and `toValues` sees the real value. Tolerant of pre-W4 rows (a
 * plaintext or absent value is left as-is). Returns a new object. Server-side only.
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
