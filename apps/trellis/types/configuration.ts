export interface LinkedAccount {
	provider: "github" | "gitlab" | "bitbucket";
	username: string;
	avatar_url?: string;
	linked_at: string;
	has_token: boolean;
}
