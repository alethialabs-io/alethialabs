// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Database } from "@/types/database-custom.types";
import { createClient } from "@supabase/supabase-js";
import { env } from "next-runtime-env";

export async function createServiceRoleClient() {
	return createClient<Database>(
		env("NEXT_PUBLIC_SUPABASE_URL")!,
		env("SERVICE_ROLE_SECRET")!,
		{
			// auth: {
			// 	persistSession: false,
			// 	autoRefreshToken: false,
			// 	detectSessionInUrl: false,
			// },
		},
	);
}
