// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "drizzle-kit";

// drizzle-kit runs outside Next, so it reads process.env directly (the migration
// /service role — bypasses RLS). The app runtime uses lib/config/database.ts.
export default defineConfig({
	dialect: "postgresql",
	schema: "./lib/db/schema/index.ts",
	out: "./lib/db/migrations",
	dbCredentials: {
		url: process.env.ALETHIA_DATABASE_URL ?? "",
	},
	// Raw-SQL programmables (enums already covered, plus triggers + SECURITY
	// DEFINER RPCs + RLS policies) are authored as custom migrations alongside
	// the generated ones.
	casing: "snake_case",
});
