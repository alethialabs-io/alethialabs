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
import { pgErrorCode } from "@/lib/db/pg-error";
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

/** The one refusal a registration that conflicts with an existing key receives. */
const KEY_NOT_REGISTERED = "This public key can't be registered for this organization.";

/**
 * Registers an org receipt-signing key. Org-gated (`edit` on `org`); shape-validates the input
 * (valid ed25519 public key; non-empty `key_ref`), derives the `key_id` SERVER-SIDE from the public
 * key (never trusts a client-supplied id), and inserts a `pending_verification` row storing the
 * reference + public key only. The key is NOT usable until the proof-of-possession job (follow-on)
 * activates it.
 *
 * A key the org has already registered is refused, and so is any other unique-key conflict, with ONE
 * sentence ({@link KEY_NOT_REGISTERED}) — never the database's error, and never a different answer
 * for a key another organization holds: registration does not say what other tenants have.
 */
export async function registerOrgSigningKey(
	input: SigningKeyRegisterInput,
): Promise<{ ok: true; id: string; keyId: string; status: string }> {
	const actor = await authorize("edit", { type: "org" });
	const parsed = signingKeyRegisterSchema.parse(input);
	const keyId = keyIdForPublicKey(parsed.public_key);

	try {
		return await withActorScope(actor, async (tx) => {
			const [existing] = await tx
				.select({ id: orgSigningKey.id })
				.from(orgSigningKey)
				.where(and(eq(orgSigningKey.org_id, actor.orgId), eq(orgSigningKey.key_id, keyId)))
				.limit(1);
			if (existing) throw new Error(KEY_NOT_REGISTERED);
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
	} catch (err) {
		// The loser of two concurrent registrations of one key in one org meets the index, not the
		// read above; it gets the same sentence.
		if (pgErrorCode(err) === "23505") throw new Error(KEY_NOT_REGISTERED);
		throw err;
	}
}

/** All of the caller-org's signing keys (active + pending + rotation history). Org-gated (`view`). */
export async function getOrgSigningKeys(): Promise<OrgSigningKeyView[]> {
	const actor = await authorize("view", { type: "org" });
	return withActorScope(actor, (tx) => readOrgSigningKeys(tx, actor.orgId));
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
			.where(and(eq(orgSigningKey.id, id), eq(orgSigningKey.org_id, actor.orgId))),
	);
	return { ok: true };
}
