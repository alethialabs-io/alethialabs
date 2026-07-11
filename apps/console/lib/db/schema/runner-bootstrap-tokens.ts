// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { runners } from "./runners";

/**
 * Per-VM fleet bootstrap tokens (E0 Step 0b). Each managed fleet VM is minted its OWN
 * short-TTL bootstrap token when the scaler creates it (recorded here), injected into that
 * VM's cloud-init instead of one shared secret. So a token leaked via the Hetzner metadata
 * userdata is bounded to that one VM and dead once `expires_at` passes.
 *
 * The token is **instance-bound, reusable within its TTL**: the first redeem binds
 * `instance_id`; the same instance may re-redeem (a `--restart=always` re-bootstrap or a
 * lost-response retry) and rotate its runner token, but a DIFFERENT instance is rejected.
 * `runner_id` links the runner the token created (nullable — set on redeem). Redeem is atomic
 * via `redeem_bootstrap_token` (programmables.sql).
 */
export const runnerBootstrapTokens = pgTable("runner_bootstrap_tokens", {
	id: uuid().primaryKey().defaultRandom(),
	token_hash: text().notNull().unique(),
	instance_id: text(),
	runner_id: uuid().references(() => runners.id, { onDelete: "set null" }),
	expires_at: timestamp({ withTimezone: true }).notNull(),
	created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export type RunnerBootstrapToken = typeof runnerBootstrapTokens.$inferSelect;
