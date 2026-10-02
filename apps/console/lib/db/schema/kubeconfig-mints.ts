// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Short-lived kubeconfig mint requests (#5250 decisions 7–8; seams #5280).
//
// One row per `POST /api/cli/clusters/:id/kubeconfig`. The CLIENT (the `alethia` CLI, or the browser
// through WebCrypto) generates an ephemeral X25519 keypair and sends only the public half. A
// MINT_KUBECONFIG job runs on the org's runner, which mints the credential in-network and SEALS it
// to that public key with HPKE (RFC 9180 base mode, DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 /
// AES-256-GCM — packages/core/kubeaccess/seal.go), with the AAD bound to this row's `id` and
// `cluster_id`. The runner posts the ciphertext here; the client polls, reads it once, and opens it.
//
// WHAT THIS TABLE MUST NEVER HOLD: a plaintext credential. There is no token, certificate, key or
// kubeconfig column, and there must never be one — the console cannot open `sealed_result` because
// it never sees the client's private key. That is the whole point of the channel: the plaintext
// exists on the runner and on the client and nowhere in between (#5250 §2, §5 "Keyless").
//
// LIFETIME. A row is short-lived by construction: a `ready` row is DELETED on its first successful
// read, and the sweep expires every row past `expires_at` (nulling any ciphertext it still holds).
// `expires_at` is the POLL WINDOW — how long the request may wait for and hold its sealed result —
// not the credential's TTL, which is `ttl_seconds` and is enforced by the cloud / the cluster.
//
// CREDENTIAL. A row is bound to the credential that asked (#5310): `service_token_id` for a CLI service
// token, NULL for a person's session. The poll matches it, so another token of the same person — which
// carries the same actor_user_id — cannot collect (and so consume) the mint.
//
// TENANCY. `org_id` is the actor's active org, copied from the project_cluster row the route
// resolved with `project_cluster.org_id = actor.orgId` (#5250 §2 "For which cluster"). It carries no
// FK to `organization` for the reason cli_service_tokens records: a community user's personal org id
// is their profile id, not an `organization` row. The RLS policy (programmables.sql) is org- AND
// actor-scoped — a mint request is its requester's alone, so a teammate in the same org can neither
// read nor delete it through the app role. The runner's result post and the sweep use the service
// role and filter on the row id, the job id and the org explicitly.

import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { profiles } from "./accounts";
import { cliServiceTokens } from "./cli-service-tokens";
import {
	kubeconfigMintShape,
	kubeconfigMintStatus,
	kubeconfigMintTier,
} from "./enums";
import { jobs } from "./jobs";
import { projectCluster } from "./project-components";

/** Shortest credential a mint may request, in seconds (15 min). The floor is the tightest of the
 *  minters it must satisfy: ACK's `TemporaryDurationMinutes` minimum is 15, and Kubernetes
 *  TokenRequest refuses `expirationSeconds` under 600. */
export const KUBECONFIG_MINT_TTL_MIN_SECONDS = 900;
/** The credential TTL when the client names none (1h — #5250 §2 "TTL"). */
export const KUBECONFIG_MINT_TTL_DEFAULT_SECONDS = 3600;
/** Longest credential a mint may request (8h — #5250 §2 "TTL"; never renewable without a new mint). */
export const KUBECONFIG_MINT_TTL_MAX_SECONDS = 28_800;
/** How long a request row lives to be polled before the sweep expires it (10 min). The runner
 *  must post inside it; the client must read inside it. Not the credential's lifetime. */
export const KUBECONFIG_MINT_REQUEST_WINDOW_SECONDS = 600;
/** Base64url (unpadded) length of a 32-byte X25519 public key — the only key this channel accepts. */
export const KUBECONFIG_MINT_PUBLIC_KEY_B64URL_LENGTH = 43;
/** Upper bound on the stored ciphertext (base64url chars). A kubeconfig is a few KiB; this caps what
 *  a misbehaving runner can park in a row, not what a real one produces. */
export const KUBECONFIG_MINT_SEALED_MAX_LENGTH = 65_536;

export const kubeconfigMintRequests = pgTable(
	"kubeconfig_mint_requests",
	{
		// Bound into the HPKE AAD (with cluster_id), so a sealed blob cannot be replayed onto another
		// request. It is the poll handle the client holds.
		id: uuid().primaryKey().defaultRandom(),
		// Coarse tenancy (RLS). The actor's active org, copied from the resolved cluster row.
		org_id: uuid().notNull(),
		// The ONE cluster the credential names (mint-bind, #5250 §5 §7). Bound into the AAD.
		cluster_id: uuid()
			.notNull()
			.references(() => projectCluster.id, { onDelete: "cascade" }),
		// The MINT_KUBECONFIG job that serves this request. Nullable only for the instant between the
		// row's insert and the job's enqueue in the same transaction; unique — one job serves one mint.
		job_id: uuid().references(() => jobs.id, { onDelete: "cascade" }),
		// Who asked. The audit row (written before the credential is returned) names them too.
		actor_user_id: uuid()
			.notNull()
			.references(() => profiles.id, { onDelete: "cascade" }),
		// WHICH CREDENTIAL asked (#5310) — and so the only one that may poll and collect. NULL means a
		// person's session (the console, or `alethia login`); otherwise the CLI service token's id.
		// actor_user_id alone cannot tell them apart: a service token acts AS the profile that minted
		// it, so every token one person mints shares their actor_user_id. The bind trigger
		// (programmables.sql) requires the token to be that same person's, in this row's org.
		service_token_id: uuid().references(() => cliServiceTokens.id, { onDelete: "cascade" }),
		tier: kubeconfigMintTier().notNull(),
		ttl_seconds: integer().notNull(),
		shape: kubeconfigMintShape().notNull(),
		// The client's EPHEMERAL X25519 public key, base64url without padding. Public material: knowing
		// it opens nothing. The private half never leaves the client.
		client_public_key: text().notNull(),
		// HPKE `enc || ciphertext`, base64url without padding. Ciphertext ONLY — see the file header.
		sealed_result: text(),
		// Non-secret reason for a `failed` mint, as the runner reported it.
		failure_reason: text(),
		status: kubeconfigMintStatus().default("pending").notNull(),
		// Whether the cluster's API endpoint is private (decision 6). NULL until the runner reports it.
		private_endpoint: boolean(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		// End of the poll window (see KUBECONFIG_MINT_REQUEST_WINDOW_SECONDS); the sweep's key.
		expires_at: timestamp({ withTimezone: true }).notNull(),
	},
	(t) => [
		index("idx_kubeconfig_mint_requests_org").on(t.org_id),
		index("idx_kubeconfig_mint_requests_cluster").on(t.cluster_id),
		index("idx_kubeconfig_mint_requests_expires").on(t.expires_at),
		uniqueIndex("kubeconfig_mint_requests_job_id_key").on(t.job_id),
		check(
			"kubeconfig_mint_requests_ttl_range",
			sql`${t.ttl_seconds} BETWEEN ${sql.raw(String(KUBECONFIG_MINT_TTL_MIN_SECONDS))} AND ${sql.raw(String(KUBECONFIG_MINT_TTL_MAX_SECONDS))}`,
		),
		check(
			"kubeconfig_mint_requests_public_key_shape",
			sql`${t.client_public_key} ~ ${sql.raw(`'^[A-Za-z0-9_-]{${KUBECONFIG_MINT_PUBLIC_KEY_B64URL_LENGTH}}$'`)}`,
		),
		// A ciphertext exists exactly while the row is `ready`. An expired/failed row holds none.
		check(
			"kubeconfig_mint_requests_sealed_iff_ready",
			sql`(${t.status} = 'ready') = (${t.sealed_result} IS NOT NULL)`,
		),
		check(
			"kubeconfig_mint_requests_sealed_size",
			sql`${t.sealed_result} IS NULL OR length(${t.sealed_result}) <= ${sql.raw(String(KUBECONFIG_MINT_SEALED_MAX_LENGTH))}`,
		),
		check(
			"kubeconfig_mint_requests_reason_only_when_failed",
			sql`${t.failure_reason} IS NULL OR ${t.status} = 'failed'`,
		),
		// A service token never holds an admin mint (#5310): admin cluster credentials are for people,
		// not unattended automation. lib/kubeconfig-mint/gates.ts is the policy; this is its backstop.
		check(
			"kubeconfig_mint_requests_token_readonly",
			sql`${t.service_token_id} IS NULL OR ${t.tier} = 'readonly'`,
		),
		check(
			"kubeconfig_mint_requests_window",
			sql`${t.expires_at} > ${t.created_at}`,
		),
	],
);

export type KubeconfigMintRequest = typeof kubeconfigMintRequests.$inferSelect;
export type NewKubeconfigMintRequest = typeof kubeconfigMintRequests.$inferInsert;
