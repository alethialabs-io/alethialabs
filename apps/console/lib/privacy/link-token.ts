// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The one secret a privacy email carries: the cancel link of a scheduled deletion, or the download
// link of a data export. 32 random bytes, sent to the subject once and stored only as a SHA-256 on
// the case (`privacy_case.link_token_sha256`), so reading the database does not yield a working link.

import "server-only";
import { createHash, randomBytes } from "node:crypto";

/** A freshly minted link token and the hash to store for it. */
export interface LinkToken {
	/** Goes into the emailed URL. Never stored. */
	token: string;
	/** Goes onto the case. */
	sha256: string;
}

/** SHA-256 of a link token, lower-case hex. */
export function hashLinkToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** Mints a link token. */
export function mintLinkToken(): LinkToken {
	const token = randomBytes(32).toString("base64url");
	return { token, sha256: hashLinkToken(token) };
}

/** True for a string shaped like a token {@link mintLinkToken} produced (43 base64url chars). */
export function isLinkTokenShape(value: string): boolean {
	return /^[A-Za-z0-9_-]{43}$/.test(value);
}
