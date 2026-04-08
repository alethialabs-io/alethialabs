import type { UserIdentity } from "@supabase/supabase-js";
export interface LinkedAccount {
	provider: "github" | "gitlab" | "bitbucket";
	username: string;
	avatar_url?: string;
	linked_at: string;
	has_token: boolean;
	identity?: UserIdentity;
}
