// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The support-case schema now lives in @repo/support (shared with the support-admin app).
// Re-exported here so the schema barrel (schema/index.ts) and every `@/lib/db/schema`
// import site keep working. The console remains the sole migration owner.

export * from "@repo/support/schema";
