// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Inventory reconcile helper. After a sync upserts the rows it discovered (typed, per table, in the
// provider module), this soft-removes the rows of that identity it did NOT see this pass — so a
// resource deleted in-cloud is reflected on the next sweep. The same path backs the event ingester.

import { sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import {
	decryptSecret,
	encryptSecret,
	isCredEncryptionConfigured,
} from "@/lib/crypto/secrets";
import type { CloudSensitiveAttrs, EncryptedSecret } from "@/types/jsonb.types";

/**
 * Seals an inventory row's reconnaissance-sensitive attributes (CIDRs/IPs/endpoints/domains) into the
 * encrypted `sensitive` text column. Drops empty/nullish fields; returns null when there's nothing
 * sensitive. If credential encryption isn't configured, returns null (we simply don't persist the
 * sensitive projection — the interactive picker is fetch-live anyway).
 */
export function sealSensitive(attrs: CloudSensitiveAttrs): string | null {
	const fields: Record<string, string> = {};
	for (const [k, v] of Object.entries(attrs)) {
		if (v != null && v !== "") fields[k] = v;
	}
	if (Object.keys(fields).length === 0) return null;
	if (!isCredEncryptionConfigured()) return null;
	return JSON.stringify(encryptSecret(fields));
}

/** Opens a sealed `sensitive` blob back into its attributes (empty object on absent/tampered). */
export function openSensitive(sealed: string | null | undefined): CloudSensitiveAttrs {
	if (!sealed) return {};
	try {
		return decryptSecret(JSON.parse(sealed) as EncryptedSecret) as CloudSensitiveAttrs;
	} catch {
		return {};
	}
}

/**
 * Marks `removed_at` on rows of `table` for one cloud identity whose `native_id` wasn't in
 * `seenNativeIds` this sweep (and that aren't already removed). `table` is an internal literal, quoted
 * via `sql.identifier`; ids are parameterized.
 */
export async function softRemoveUnseen(
	table: string,
	cloudIdentityId: string,
	seenNativeIds: string[],
): Promise<void> {
	const db = getServiceDb();
	const unseen = seenNativeIds.length
		? sql`native_id <> all(${seenNativeIds})`
		: sql`true`;
	await db.execute(sql`
		update ${sql.identifier(table)}
		   set removed_at = now()
		 where cloud_identity_id = ${cloudIdentityId}
		   and removed_at is null
		   and ${unseen}
	`);
}
