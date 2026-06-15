// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Database } from "@/types/database-custom.types";
import { createBrowserClient } from "@supabase/ssr";
import { env } from "next-runtime-env";

export function createClient() {
	return createBrowserClient<Database>(
		env("NEXT_PUBLIC_SUPABASE_URL")!,
		env("NEXT_PUBLIC_SUPABASE_ANON_KEY")!,
	);
}
