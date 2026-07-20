"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Customer-controlled receipt-signing keys — org security setting (#884). Custody model A: an org
// registers a key it holds in its OWN cloud; Alethia stores a REFERENCE + the PUBLIC key only, never
// the private key. Registration is SHAPE-ONLY (no key is used) → the row lands `pending_verification`;
// a runner proof-of-possession job (follow-on) tests real control of `key_ref` and flips it `active`.
// This layer never signs anything, so it can't be a signing oracle.

import { and, eq } from "drizzle-orm";
import { authorize } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import { orgSigningKey } from "@/lib/db/schema";
import {
	getOrgSigningKeys as readOrgSigningKeys,
	type OrgSigningKeyView,
} from "@/lib/queries/signing";
import {
	keyIdForPublicKey,
	type SigningKeyRegisterInput,
	signingKeyRegisterSchema,
} from "@/lib/validations/signing";

/**
 * Registers an org receipt-signing key. Org-gated (`edit` on `org`); shape-validates the input
 * (valid ed25519 public key; non-empty `key_ref`), derives the `key_id` SERVER-SIDE from the public
 * key (never trusts a client-supplied id), and inserts a `pending_verification` row storing the
 * reference + public key only. Rejects a public key already registered (its key_id is UNIQUE). The
 * key is NOT usable until the proof-of-possession job (follow-on) activates it.
 */
export async function registerOrgSigningKey(
	input: SigningKeyRegisterInput,
): Promise<{ ok: true; id: string; keyId: string; status: string }> {
	const actor = await authorize("edit", { type: "org" });
	const parsed = signingKeyRegisterSchema.parse(input);
	const keyId = keyIdForPublicKey(parsed.public_key);

	return withActorScope(actor, async (tx) => {
		const [existing] = await tx
			.select({ id: orgSigningKey.id })
			.from(orgSigningKey)
			.where(eq(orgSigningKey.key_id, keyId))
			.limit(1);
		if (existing) {
			throw new Error("This public key is already registered.");
		}
		const [row] = await tx
			.insert(orgSigningKey)
			.values({
				user_id: actor.userId,
				org_id: actor.orgId,
				provider: parsed.provider,
				backend: parsed.backend,
				key_ref: parsed.key_ref,
				public_key: parsed.public_key,
				key_id: keyId,
				status: "pending_verification",
				active: false,
			})
			.returning({ id: orgSigningKey.id });
		return { ok: true, id: row.id, keyId, status: "pending_verification" };
	});
}

/** All of the caller-org's signing keys (active + pending + rotation history). Org-gated (`view`). */
export async function getOrgSigningKeys(): Promise<OrgSigningKeyView[]> {
	const actor = await authorize("view", { type: "org" });
	return withActorScope(actor, (tx) => readOrgSigningKeys(tx));
}

/**
 * Revokes a signing key: clears `active` + marks it `invalid` (append-only — the row is kept so past
 * receipts still resolve their key_id against the retained history). Org-gated (`edit`). Idempotent.
 */
export async function revokeOrgSigningKey(
	id: string,
): Promise<{ ok: true }> {
	const actor = await authorize("edit", { type: "org" });
	await withActorScope(actor, (tx) =>
		tx
			.update(orgSigningKey)
			.set({ active: false, status: "invalid", updated_at: new Date() })
			.where(and(eq(orgSigningKey.id, id))),
	);
	return { ok: true };
}
