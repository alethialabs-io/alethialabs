// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Customer-controlled receipt-signing keys (#884) — the root-of-trust seam. A platform-held key
// only attests "Alethia asserted this"; an org's OWN key makes an elench evidence receipt attest
// the CUSTOMER (non-repudiation vs Alethia). Custody model A: Alethia stores ONLY a reference +
// the PUBLIC key here — NEVER the private key. The key lives in the customer's cloud (KMS-native
// on AWS/GCP, a secret store elsewhere); the runner invokes it under the customer's revocable,
// audited keyless grant at sign time. See packages/core/verify/signer.go + verify/README.md.
//
// Append-only history (D4): rows are never deleted — a rotation inserts a new row and clears the
// old one's `active` flag, so past receipts stay verifiable against the key_id they recorded.
// At most one `active` key per org (D3); a project provisioning on a different cloud than the
// active key's `provider` falls back to the platform key / unsigned, surfaced honestly.

import { sql } from "drizzle-orm";
import {
	boolean,
	index,
	pgTable,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { cloudProvider, signingBackend, signingKeyStatus } from "./enums";

export const orgSigningKey = pgTable(
	"org_signing_key",
	{
		id: uuid().primaryKey().defaultRandom(),
		// Coarse tenancy scope (RLS blast wall); community org_id = user_id via the set_org_id trigger.
		user_id: uuid().notNull(),
		org_id: uuid(),
		// The cloud the key is custodied in. The runner uses this key only when the project's
		// provisioning cloud matches (else honest fallback).
		provider: cloudProvider().notNull(),
		// How the key is held + invoked: `kms` (AWS ECC_NIST_EDWARDS25519 / GCP EC_SIGN_ED25519, the
		// key never leaves the HSM) or `secret` (raw ed25519 in the customer's secret store).
		backend: signingBackend().notNull(),
		// A REFERENCE to the key — a KMS key resource id (kms) or a secret ARN/URI (secret). NEVER the
		// private key. The runner resolves it keyless at sign time.
		key_ref: text().notNull(),
		// base64(std) ed25519 public key the receipt signatures verify under. Public material only.
		public_key: text().notNull(),
		// Stable KeyID(public_key) — the join key from a SignedReceipt back to this row (survives
		// rotation as the append-only history's primary handle).
		key_id: text().notNull(),
		// The signature algorithm — ed25519 for now (uniform across clouds via KMS-native + secret-ref).
		algorithm: text().default("ed25519").notNull(),
		// pending_verification (shape-validated, awaiting proof-of-possession) → active | invalid.
		status: signingKeyStatus().default("pending_verification").notNull(),
		status_message: text(),
		// The one currently-signing key for the org (D3). Rotation flips the old row false + inserts new.
		active: boolean().default(false).notNull(),
		// When the proof-of-possession job confirmed the org controls key_ref (flips status→active).
		verified_at: timestamp({ withTimezone: true }),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		// key_id is the globally-unique handle a receipt records; the full row set is the retained
		// key_id→public_key history that keeps old receipts verifiable across rotation (D4).
		unique("org_signing_key_key_id_key").on(t.key_id),
		// At most one ACTIVE signing key per org (D3 — single active per-org key).
		uniqueIndex("org_signing_key_one_active")
			.on(t.org_id)
			.where(sql`${t.active} = true`),
		index("idx_org_signing_key_org").on(t.org_id),
	],
);

export type OrgSigningKey = typeof orgSigningKey.$inferSelect;
export type NewOrgSigningKey = typeof orgSigningKey.$inferInsert;
