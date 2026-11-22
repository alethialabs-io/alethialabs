// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// OAuth tokens of linked accounts (GitHub, GitLab, Bitbucket, Google) are encrypted at rest with the
// platform's credential key — the same AES-256-GCM keyring (lib/crypto/secrets.ts) that seals cloud
// API tokens, connector keys and alert secrets.
//
// WHERE: one wrapper around the Better Auth database adapter. Every write of the `account` model is
// sealed on its way in, and every read is opened on its way out, so Better Auth itself only ever
// handles plaintext: `auth.api.getAccessToken` and its refresh path work unchanged, and the refresh
// token it sends to the provider is the real one.
//
// WHY NOT Better Auth's own `account.encryptOAuthTokens`: it keys on BETTER_AUTH_SECRET rather than
// the credential keyring, and it decides whether a stored value is encrypted by a shape heuristic
// (even-length hex). A plaintext token that is itself hex (GitLab issues 64-hex tokens) reads as
// ciphertext there and fails to decrypt, so existing links would break until a backfill ran. The
// sealed form here carries an explicit prefix, so "encrypted" is a fact about the value, not a guess.
//
// TRANSITION: a value without the prefix is a plaintext row written before this change, and is
// returned as-is. `scripts/encrypt-oauth-tokens.ts` seals every such row (and re-seals rows under a
// retired key); once it has run everywhere the plaintext read path can be removed.

import type { DBAdapter, DBAdapterInstance, DBTransactionAdapter, JoinOption } from "better-auth";
import { z } from "zod";
import { decryptSecret, encryptSecret, getActiveKid } from "@/lib/crypto/secrets";
import { log } from "@/lib/observability/log";
import type { EncryptedSecret } from "@/types/jsonb.types";

/** The Better Auth model whose rows carry provider OAuth tokens. */
export const ACCOUNT_MODEL = "account";

/** The `account` fields that hold provider tokens. `idToken` is a signed bearer JWT, so it counts. */
export const OAUTH_TOKEN_FIELDS = ["accessToken", "refreshToken", "idToken"] as const;

/**
 * Marks a sealed token: `$aenc$1$` + base64url(JSON envelope). `$` is outside the alphabet of every
 * provider token format we store (hex, base64/base64url, `gho_`-style prefixes, JWTs), so a stored
 * value either starts with this and is ciphertext, or it does not and is a legacy plaintext row.
 */
export const SEALED_TOKEN_PREFIX = "$aenc$1$";

/** The JSON field the token is stored under inside the encrypted envelope. */
const ENVELOPE_FIELD = "token";

const envelopeSchema = z.object({
	v: z.number(),
	kid: z.string().optional(),
	iv: z.string(),
	tag: z.string(),
	data: z.string(),
});

/** Whether a stored value is in the sealed (encrypted) form. */
export function isSealedOAuthToken(stored: string): boolean {
	return stored.startsWith(SEALED_TOKEN_PREFIX);
}

/** Encrypts a token under the active credential key. Throws when no key is configured. */
export function sealOAuthToken(token: string): string {
	const envelope = encryptSecret({ [ENVELOPE_FIELD]: token });
	return SEALED_TOKEN_PREFIX + Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

/** Parses the envelope out of a sealed value. Throws when the value is not a well-formed sealed token. */
function parseSealed(stored: string): EncryptedSecret {
	const json = Buffer.from(stored.slice(SEALED_TOKEN_PREFIX.length), "base64url").toString("utf8");
	return envelopeSchema.parse(JSON.parse(json));
}

/**
 * Returns the token a stored value holds. A plaintext (pre-encryption) value is returned unchanged; a
 * sealed one is decrypted. Throws when a sealed value cannot be decrypted (tampered, or its key is
 * not in the ring) — it never returns ciphertext as if it were a token.
 */
export function openOAuthToken(stored: string): string {
	if (!isSealedOAuthToken(stored)) return stored;
	const fields = decryptSecret(parseSealed(stored));
	const token = fields[ENVELOPE_FIELD];
	if (typeof token !== "string") throw new Error("sealed OAuth token envelope has no token");
	return token;
}

/**
 * Brings one stored value to the sealed form under the ACTIVE key: plaintext is sealed, a value sealed
 * under a retired key is re-sealed, and a value already under the active key is left alone. Idempotent
 * by construction. Throws when a sealed value cannot be decrypted, so the caller never overwrites it.
 */
export function resealOAuthToken(stored: string | null): { value: string | null; changed: boolean } {
	if (stored === null || stored === "") return { value: stored, changed: false };
	if (!isSealedOAuthToken(stored)) return { value: sealOAuthToken(stored), changed: true };
	if (parseSealed(stored).kid === getActiveKid()) return { value: stored, changed: false };
	return { value: sealOAuthToken(openOAuthToken(stored)), changed: true };
}

/**
 * A copy of `data` whose token fields are sealed. Every non-empty string is sealed — including one
 * that already looks sealed — because a write always receives plaintext from Better Auth (reads
 * hand it plaintext), and sealing unconditionally means nothing a caller passes is stored as-is.
 */
function sealTokenFields<D extends object>(data: D): D {
	const copy = { ...data };
	for (const field of OAUTH_TOKEN_FIELDS) {
		const value: unknown = Reflect.get(copy, field);
		if (typeof value === "string" && value !== "") Reflect.set(copy, field, sealOAuthToken(value));
	}
	return copy;
}

/**
 * Opens the token fields of one account row in place. A sealed value that cannot be decrypted becomes
 * null — to every caller that is "no usable token", which asks the user to reconnect — and is logged
 * by field and row id only, never by value.
 */
function openTokenFields(row: unknown): void {
	if (typeof row !== "object" || row === null) return;
	for (const field of OAUTH_TOKEN_FIELDS) {
		const value: unknown = Reflect.get(row, field);
		if (typeof value !== "string") continue;
		try {
			Reflect.set(row, field, openOAuthToken(value));
		} catch {
			Reflect.set(row, field, null);
			const id: unknown = Reflect.get(row, "id");
			log.warn("[auth] a stored OAuth token could not be decrypted; treating it as absent", {
				field,
				accountId: typeof id === "string" ? id : undefined,
			});
		}
	}
}

/** Opens every account row a query result carries: the row itself, or the `account` it joined. */
function openResult(model: string, join: JoinOption | undefined, result: unknown): void {
	if (typeof result !== "object" || result === null) return;
	if (model === ACCOUNT_MODEL) openTokenFields(result);
	if (join && ACCOUNT_MODEL in join) {
		const joined: unknown = Reflect.get(result, ACCOUNT_MODEL);
		if (Array.isArray(joined)) joined.forEach(openTokenFields);
		else openTokenFields(joined);
	}
}

/** The argument of an adapter's `create`, for a row of shape `T`. */
interface CreateArgs<T> {
	model: string;
	data: Omit<T, "id">;
	select?: string[] | undefined;
	forceAllowId?: boolean | undefined;
}
type FindOneArgs = Parameters<DBTransactionAdapter["findOne"]>[0];
type FindManyArgs = Parameters<DBTransactionAdapter["findMany"]>[0];
type UpdateArgs = Parameters<DBTransactionAdapter["update"]>[0];
type UpdateManyArgs = Parameters<DBTransactionAdapter["updateMany"]>[0];
type ConsumeOneArgs = Parameters<DBTransactionAdapter["consumeOne"]>[0];
type IncrementOneArgs = Parameters<DBTransactionAdapter["incrementOne"]>[0];

/** Wraps every data method of an adapter (or a transaction's adapter) to seal and open tokens. */
function wrapMethods(inner: DBTransactionAdapter): DBTransactionAdapter {
	return {
		...inner,
		create: async <T extends Record<string, unknown>, R = T>(args: CreateArgs<T>): Promise<R> => {
			const data = args.model === ACCOUNT_MODEL ? sealTokenFields(args.data) : args.data;
			const created = await inner.create<T, R>({ ...args, data });
			openResult(args.model, undefined, created);
			return created;
		},
		update: async <T>(args: UpdateArgs): Promise<T | null> => {
			const update = args.model === ACCOUNT_MODEL ? sealTokenFields(args.update) : args.update;
			const updated = await inner.update<T>({ ...args, update });
			openResult(args.model, undefined, updated);
			return updated;
		},
		updateMany: async (args: UpdateManyArgs): Promise<number> => {
			const update = args.model === ACCOUNT_MODEL ? sealTokenFields(args.update) : args.update;
			return inner.updateMany({ ...args, update });
		},
		incrementOne: async <T>(args: IncrementOneArgs): Promise<T | null> => {
			const set = args.model === ACCOUNT_MODEL && args.set ? sealTokenFields(args.set) : args.set;
			const row = await inner.incrementOne<T>({ ...args, set });
			openResult(args.model, undefined, row);
			return row;
		},
		findOne: async <T>(args: FindOneArgs): Promise<T | null> => {
			const row = await inner.findOne<T>(args);
			openResult(args.model, args.join, row);
			return row;
		},
		findMany: async <T>(args: FindManyArgs): Promise<T[]> => {
			const rows = await inner.findMany<T>(args);
			for (const row of rows) openResult(args.model, args.join, row);
			return rows;
		},
		consumeOne: async <T>(args: ConsumeOneArgs): Promise<T | null> => {
			const row = await inner.consumeOne<T>(args);
			openResult(args.model, undefined, row);
			return row;
		},
	};
}

/** Wraps a built adapter, including the adapter each transaction hands its callback. */
function wrapAdapter(inner: DBAdapter): DBAdapter {
	return {
		...wrapMethods(inner),
		transaction: <R>(callback: (trx: DBTransactionAdapter) => Promise<R>): Promise<R> =>
			inner.transaction((trx) => callback(wrapMethods(trx))),
	};
}

/**
 * Wraps a Better Auth adapter so `account` OAuth tokens are encrypted at rest. Use it around the
 * adapter passed as `database` to `betterAuth()`; nothing else changes for callers.
 */
export function withEncryptedOAuthTokens(adapter: DBAdapterInstance): DBAdapterInstance {
	return (options) => wrapAdapter(adapter(options));
}
