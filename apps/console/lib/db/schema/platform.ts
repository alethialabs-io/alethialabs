// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The platform-operator schema lives in @repo/platform (owned by the staff app, apps/admin).
// Re-exported here for ONE reason: the console is the sole migration owner, so its drizzle-kit
// schema barrel must see these tables to create them. The console itself never reads or writes
// them — all operator logic lives in apps/admin. Mirrors how @repo/support is wired.

export * from "@repo/platform/schema";
