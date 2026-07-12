// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Setup for the real-Postgres integration suite. Points the DB client at the dev stack
// (`pnpm db:up`) unless the real env already provides URLs, and makes `next-runtime-env`'s
// `env()` read straight from process.env (same shim as the unit setup). The suite assumes the
// dev DB is already migrated; `tests/integration/db.ts` skips everything if it's unreachable.

import { vi } from "vitest";

// The documented dev-stack URLs (CLAUDE.md / .env.example). Real env wins if set.
process.env.ALETHIA_DATABASE_URL ||=
	"postgres://alethia:alethia-dev-secret@localhost:5433/alethia";
process.env.ALETHIA_APP_DATABASE_URL ||=
	"postgres://alethia_app:alethia-app-dev-secret@localhost:5433/alethia";

// Hermetic auth-config defaults. Some integration tests import server actions whose module graph
// pulls in lib/auth/owner → getAuthConfig(), which THROWS at import if these are unset (e.g. the
// reconcile suite imports maybeAutoHeal). The suite does no real auth flow, so dummy values are safe;
// real env wins if provided. Set BEFORE any test module loads (setupFiles run first).
process.env.BETTER_AUTH_SECRET ||= "integration-test-secret-not-used-for-real-auth";
process.env.BETTER_AUTH_URL ||= "http://localhost:3000";
process.env.NEXT_PUBLIC_APP_URL ||= "http://localhost:3000";

vi.mock("next-runtime-env", () => ({
	env: (key: string) => process.env[key],
}));
