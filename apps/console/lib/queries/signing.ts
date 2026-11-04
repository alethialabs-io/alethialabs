// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Typed reads for org receipt-signing keys (#884) + the pure "honest posture" resolver the receipt
// panel uses to say WHICH key would sign a project's receipts (and why it's not the org's key yet).

import { desc, eq } from "drizzle-orm";
import type { Tx } from "@/lib/db";
import { orgSigningKey } from "@/lib/db/schema";

/** An org signing key as surfaces read it — reference + PUBLIC key only (never private material). */
export interface OrgSigningKeyView {
	id: string;
	provider: string;
	backend: "kms" | "secret";
	keyRef: string;
	keyId: string;
	publicKey: string;
	algorithm: string;
	status: "pending_verification" | "active" | "invalid";
	active: boolean;
	statusMessage: string | null;
	verifiedAt: string | null;
	createdAt: string;
}

/** Maps a row to the read view. */
function toView(r: typeof orgSigningKey.$inferSelect): OrgSigningKeyView {
	return {
		id: r.id,
		provider: r.provider,
		backend: r.backend,
		keyRef: r.key_ref,
		keyId: r.key_id,
		publicKey: r.public_key,
		algorithm: r.algorithm,
		status: r.status,
		active: r.active,
		statusMessage: r.status_message,
		verifiedAt: r.verified_at?.toISOString() ?? null,
		createdAt: r.created_at.toISOString(),
	};
}

/**
 * All of `orgId`'s signing keys (active + pending + the retained rotation history), newest first.
 * `tx` is an actor-scoped transaction; the explicit `org_id` predicate names the addressed org, so
 * the listing is that org's keys alone — not every row the scope's RLS policy also admits (the
 * caller's personal org).
 */
export async function getOrgSigningKeys(
	tx: Tx,
	orgId: string,
): Promise<OrgSigningKeyView[]> {
	const rows = await tx
		.select()
		.from(orgSigningKey)
		.where(eq(orgSigningKey.org_id, orgId))
		.orderBy(desc(orgSigningKey.created_at));
	return rows.map(toView);
}

/**
 * WHO signs a project's receipts, honestly (#884). The receipt panel shows this so a customer is
 * never misled that their own key signed when it didn't:
 *  - `org_active`   — an active org key for this project's cloud → receipts are customer-signed.
 *  - `org_pending`  — an org key is registered but not yet proof-verified → still platform-signed.
 *  - `org_wrong_cloud` — an active org key exists, but for a DIFFERENT cloud than this project.
 *  - `platform`     — no org key → the platform key signs ("Alethia asserted this").
 * Pure: takes the org's keys + the project's provisioning cloud.
 */
export type ReceiptSignerPosture =
	| "org_active"
	| "org_pending"
	| "org_wrong_cloud"
	| "platform";

export function resolveReceiptSignerPosture(
	keys: Pick<OrgSigningKeyView, "provider" | "status" | "active">[],
	projectProvider: string | null,
): { posture: ReceiptSignerPosture; reason: string } {
	const active = keys.filter((k) => k.active && k.status === "active");
	if (projectProvider && active.some((k) => k.provider === projectProvider)) {
		return { posture: "org_active", reason: "signed by your organization's key" };
	}
	if (active.length > 0) {
		return {
			posture: "org_wrong_cloud",
			reason: projectProvider
				? `your signing key is in ${active[0].provider}, but this project provisions in ${projectProvider}`
				: "your signing key is for a different cloud than this project",
		};
	}
	if (keys.some((k) => k.status === "pending_verification")) {
		return {
			posture: "org_pending",
			reason: "your signing key is awaiting proof-of-possession verification",
		};
	}
	return { posture: "platform", reason: "signed by the Alethia platform key" };
}
