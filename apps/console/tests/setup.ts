// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// Better Auth (lib/config/auth.ts) and the DB client (lib/config/database.ts)
// validate env at import. Provide test-safe values; no real connection is made
// (postgres-js connects lazily).
const TEST_ENV: Record<string, string> = {
	BETTER_AUTH_SECRET: "test-secret-not-used",
	NEXT_PUBLIC_APP_URL: "http://localhost:3000",
	ALETHIA_DATABASE_URL: "postgres://test:test@localhost:5432/test",
};
Object.assign(process.env, TEST_ENV);

// next-runtime-env's env() throws for non-public vars in a browser (jsdom) runtime;
// resolve straight from process.env in tests so server-only config (auth/db) loads.
vi.mock("next-runtime-env", () => ({
	env: (key: string) => process.env[key],
}));
