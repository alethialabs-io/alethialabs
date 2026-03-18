import { Database } from "@/types/database.types";
import { createBrowserClient } from "@supabase/ssr";
import { env } from "next-runtime-env";

export function createClient() {
	return createBrowserClient<Database>(
		env("NEXT_PUBLIC_SUPABASE_URL")!,
		env("NEXT_PUBLIC_SUPABASE_ANON_KEY")!,
	);
}
