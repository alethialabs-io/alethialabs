// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { profiles } from "./accounts";

/**
 * Service-account tokens for driving `alethia` NON-INTERACTIVELY — a customer's CI, a cron, a
 * deploy pipeline.
 *
 * WHY THIS EXISTS. The CLI's only way in was the RFC 8628 device flow: `alethia login` opens a
 * browser, a human approves, and a token pair lands in `~/.config/alethia/credentials.json`. That is
 * the right experience at a terminal and an impossible one in a pipeline, so "drive Alethia from
 * your own CI" was a claim with no mechanism behind it. Our own CLI proof bar shows the shape of the
 * gap: it executes `alethia <cmd> --help` and nothing else, because it cannot authenticate — so it
 * proves the commands EXIST, never that they WORK.
 *
 * OPAQUE, NOT A JWT — and the reason is revocation. A signed JWT is valid until it expires; there is
 * no way to withdraw one without a server-side denylist, and once a denylist exists the signature has
 * bought nothing. A long-lived credential a customer cannot revoke the moment it leaks is not a
 * credential we should be issuing. So the token is random bytes, stored as a HASH, and revoking it is
 * a single UPDATE. This is the same shape `runner_bootstrap_tokens` already uses.
 *
 * THE PLAINTEXT IS SHOWN ONCE AND NEVER STORED. `token_hash` is a SHA-256 of the full token; the
 * column is unique so a lookup is one indexed read on the request path.
 */
export const cliServiceTokens = pgTable("cli_service_tokens", {
	id: uuid().primaryKey().defaultRandom(),
	/**
	 * The ORG this token acts as, fixed at mint time.
	 *
	 * Load-bearing for isolation. Interactive CLI sessions carry their org in an `X-Alethia-Org`
	 * header the client chooses, which is fine when a human's own memberships bound it. A service
	 * token has no human behind it, so honouring that header would let a token minted for one org
	 * act on another. The token's org WINS — see `resolveServiceToken`.
	 */
	/*
	 * NO FOREIGN KEY, deliberately — and this is a trap worth stating rather than a shortcut.
	 *
	 * An org id is not always a row in `organization`. A community user's PERSONAL org is their own
	 * profile id (`Actor.orgId === userId`; `isOrgMember` returns true for that case without reading
	 * a table). A `references(() => organization.id)` would therefore reject a token minted by every
	 * single-user account on the platform, at INSERT time, with a foreign-key violation that names
	 * the wrong problem entirely.
	 *
	 * `role.organization_id` in authz.ts carries no FK for exactly this reason. The tenancy boundary
	 * is enforced by the query scoping in every CLI route, not by this constraint.
	 */
	organization_id: uuid().notNull(),
	/** Human label, so a list of tokens is a list of PURPOSES rather than a list of prefixes. */
	name: text().notNull(),
	/** SHA-256 of the full token. The plaintext is never persisted. */
	token_hash: text().notNull().unique(),
	/**
	 * The token's leading identifying segment (`alethia_sat_` + the first 8 chars), stored so the
	 * console can show WHICH token a row is without holding the secret. Also what a reader matches
	 * against a leaked string found in a log or a repo.
	 */
	token_prefix: text().notNull(),
	/** Who minted it. Retained after that profile is deleted — an audit row that erases its actor
	 * answers the wrong half of "who did this". */
	created_by: uuid().references(() => profiles.id, { onDelete: "set null" }),
	created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	/** Optional expiry. NULL means non-expiring, which is a deliberate choice a user makes. */
	expires_at: timestamp({ withTimezone: true }),
	/**
	 * Set on use, best-effort and asynchronously.
	 *
	 * This is what makes an unused token FINDABLE. The commonest real-world failure with long-lived
	 * credentials is not theft, it is accumulation: tokens nobody remembers minting, held by
	 * pipelines nobody runs. A `last_used_at` column is what lets somebody clean that up.
	 */
	last_used_at: timestamp({ withTimezone: true }),
	/** Set on revoke. The row is KEPT, not deleted: a revoked token that vanishes takes its audit
	 * trail with it, and "this token was revoked on the 3rd" is the fact an incident needs. */
	revoked_at: timestamp({ withTimezone: true }),
});

export type CliServiceToken = typeof cliServiceTokens.$inferSelect;
export type NewCliServiceToken = typeof cliServiceTokens.$inferInsert;
