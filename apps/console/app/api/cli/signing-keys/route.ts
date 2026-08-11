// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import { platformSigningKey } from "@/lib/evidence/platform-key";
import { getOrgSigningKeys } from "@/lib/queries/signing";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import {
	cliSigningKeysResponse,
	signingKeyWire,
} from "@/lib/validations/cli-contract";
import type { z } from "zod";

/** One entry on the trusted-key wire. */
type SigningKeyWire = z.infer<typeof signingKeyWire>;

/**
 * The trusted-key set for evidence-receipt verification (#2331).
 *
 * `alethia verify receipt` binds a `SignedReceipt.key_id` to a key the control plane vouches for,
 * rather than to the public key the receipt carries about itself — a self-signed receipt verifies
 * against its own embedded key no matter who made it, so self-verification proves the blob was not
 * mangled and nothing more.
 *
 * Returns PUBLIC key material only: the org's retained key_id→public_key history
 * (`org_signing_key`, append-only across rotation so old receipts stay verifiable) plus the
 * platform key the runner actually signs with today. `key_ref` and `backend` are deliberately not
 * on the wire — custody detail is not a verifier's business, and `key_ref` names a resource in the
 * customer's cloud.
 *
 * Org-gated (`view` on `org`) and RLS-scoped, so a caller sees only their own org's keys. The
 * platform entry is the same for everyone and is not org-specific.
 */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "org" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const orgKeys = await withActorScope(actor, (tx) => getOrgSigningKeys(tx));

		const signing_keys: SigningKeyWire[] = orgKeys.map((k) => ({
			key_id: k.keyId,
			public_key: k.publicKey,
			algorithm: k.algorithm,
			source: "org" as const,
			provider: k.provider,
			status: k.status,
			active: k.active,
		}));

		// Absent when the deployment configures no signing key — its receipts carry
		// `algorithm:"none"` and there is genuinely nothing to vouch for.
		const platform = platformSigningKey();
		if (platform) {
			signing_keys.push({
				key_id: platform.keyId,
				public_key: platform.publicKey,
				algorithm: platform.algorithm,
				source: "platform" as const,
				provider: null,
				status: null,
				active: true,
			});
		}

		return cliJson(cliSigningKeysResponse, { signing_keys });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
