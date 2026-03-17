"use client";

import { GitProviderIcon } from "@/components/git-provider-icon";
import { PublicGitProvider } from "@/lib/validations/db.schemas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { createClient } from "@/lib/supabase/client";
import type { LinkedAccount } from "@/types/configuration";
import { LinkIcon, Unlink } from "lucide-react";
import { useEffect, useState } from "react";

export function LinkedAccounts() {
	const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccount[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		fetchLinkedAccounts();
	}, []);

	const fetchLinkedAccounts = async () => {
		try {
			const supabase = createClient();
			const {
				data: { user },
			} = await supabase.auth.getUser();

			if (!user) return;

			const identities = user.identities || [];
			const accounts: LinkedAccount[] = identities
				.filter((identity) =>
					["github", "gitlab", "bitbucket"].includes(identity.provider)
				)
				.map((identity) => ({
					provider: identity.provider as PublicGitProvider,
					username:
						identity.identity_data?.user_name ||
						identity.identity_data?.preferred_username ||
						identity.identity_data?.name ||
						"Unknown",
					avatar_url: identity.identity_data?.avatar_url,
					linked_at: identity.created_at || "",
					has_token: true, // Assumed true if linked
				}));

			// Remove duplicates, keep most recent if any
			const uniqueAccounts = accounts.reduce((acc, current) => {
				const x = acc.find(
					(item) => item.provider === current.provider
				);
				if (!x) {
					return acc.concat([current]);
				} else {
					return acc;
				}
			}, [] as LinkedAccount[]);

			setLinkedAccounts(uniqueAccounts);
		} catch (error) {
			console.error("[v0] Error fetching linked accounts:", error);
		} finally {
			setLoading(false);
		}
	};

	const handleLinkAccount = async (provider: PublicGitProvider) => {
		try {
			const supabase = createClient();

            // Verify session is valid before linking
            const { data: { user }, error: userError } = await supabase.auth.getUser();
            
            if (userError || !user) {
                console.error("Session invalid, signing out:", userError);
                await supabase.auth.signOut();
                window.location.href = "/auth/signin"; // Redirect to login
                return;
            }
			
			const { error } = await supabase.auth.linkIdentity({
				provider,
				options: {
					redirectTo: `${window.location.origin}/api/auth/callback?next=/dashboard/profile&provider=${provider}`,
					scopes: provider === "github" ? "repo" : undefined,
				},
			});

			if (error) throw error;
		} catch (err) {
			console.error(`[v0] Error linking ${provider}:`, err);
		}
	};

	if (loading) {
		return (
			<Card className="shadow-sm border-border/40">
				<CardHeader className="border-b border-border/40 pb-4 bg-muted/5">
					<CardTitle className="text-base font-medium">
						Linked Accounts
					</CardTitle>
					<CardDescription className="text-xs">
						Connect your Git providers to access repositories.
					</CardDescription>
				</CardHeader>
				<CardContent className="pt-6">
					<div className="animate-pulse space-y-3">
						<div className="h-16 bg-muted/50 rounded-md border border-border/50"></div>
						<div className="h-16 bg-muted/50 rounded-md border border-border/50"></div>
					</div>
				</CardContent>
			</Card>
		);
	}

	return (
		<Card className="shadow-sm border-border/40">
			<CardHeader className="border-b border-border/40 pb-4 bg-muted/5">
				<CardTitle className="text-base font-medium">
					Linked Accounts
				</CardTitle>
				<CardDescription className="text-xs">
					Connect your Git providers to access repositories.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4 pt-6">
				{linkedAccounts.map((account) => (
					<div
						key={account.provider}
						className="flex items-center justify-between p-4 border border-border/50 rounded-md bg-background hover:bg-muted/10 transition-colors"
					>
						<div className="flex items-center gap-4">
							<div className="p-2.5 rounded-md border border-border/50 bg-background shadow-sm flex items-center justify-center grayscale opacity-80">
								<GitProviderIcon provider={account.provider} size={20} />
							</div>
							<div>
								<div className="flex items-center gap-2 mb-1">
									<p className="font-medium text-sm text-foreground capitalize leading-none">
										{account.provider}
									</p>
									<Badge
										variant="outline"
										className="font-normal text-[10px] uppercase px-2 py-0 h-4.5 border-emerald-200/50 bg-emerald-50/50 text-emerald-600"
									>
										Connected
									</Badge>
								</div>
								<p className="text-xs text-muted-foreground leading-none">
									@{account.username}
								</p>
							</div>
						</div>
						<Button variant="outline" size="sm" disabled className="h-8 text-xs font-medium border-border/50">
							<Unlink className="w-3.5 h-3.5 mr-1.5 opacity-70" />
							Disconnect
						</Button>
					</div>
				))}

				{/* Show available providers to link */}
				{!linkedAccounts.some((a) => a.provider === "github") && (
					<div className="flex items-center justify-between p-4 border border-dashed border-border/60 rounded-md bg-muted/5">
						<div className="flex items-center gap-4">
							<div className="p-2.5 rounded-md border border-border/50 bg-background flex items-center justify-center grayscale opacity-50">
								<GitProviderIcon provider="github" size={20} />
							</div>
							<div>
								<p className="font-medium text-sm text-foreground mb-1 leading-none">GitHub</p>
								<p className="text-xs text-muted-foreground leading-none">
									Not connected
								</p>
							</div>
						</div>
						<Button
							variant="outline"
							size="sm"
							onClick={() => handleLinkAccount("github")}
							className="h-8 text-xs font-medium border-border/50 bg-background"
						>
							<LinkIcon className="w-3.5 h-3.5 mr-1.5 opacity-70" />
							Connect
						</Button>
					</div>
				)}

				{!linkedAccounts.some((a) => a.provider === "gitlab") && (
					<div className="flex items-center justify-between p-4 border border-dashed border-border/60 rounded-md bg-muted/5">
						<div className="flex items-center gap-4">
							<div className="p-2.5 rounded-md border border-border/50 bg-background flex items-center justify-center grayscale opacity-50">
								<GitProviderIcon provider="gitlab" size={20} />
							</div>
							<div>
								<p className="font-medium text-sm text-foreground mb-1 leading-none">GitLab</p>
								<p className="text-xs text-muted-foreground leading-none">
									Not connected
								</p>
							</div>
						</div>
						<Button
							variant="outline"
							size="sm"
							onClick={() => handleLinkAccount("gitlab")}
							className="h-8 text-xs font-medium border-border/50 bg-background"
						>
							<LinkIcon className="w-3.5 h-3.5 mr-1.5 opacity-70" />
							Connect
						</Button>
					</div>
				)}

				{!linkedAccounts.some((a) => a.provider === "bitbucket") && (
					<div className="flex items-center justify-between p-4 border border-dashed border-border/60 rounded-md bg-muted/5">
						<div className="flex items-center gap-4">
							<div className="p-2.5 rounded-md border border-border/50 bg-background flex items-center justify-center grayscale opacity-50">
								<GitProviderIcon provider="bitbucket" size={20} />
							</div>
							<div>
								<p className="font-medium text-sm text-foreground mb-1 leading-none">Bitbucket</p>
								<p className="text-xs text-muted-foreground leading-none">
									Not connected
								</p>
							</div>
						</div>
						<Button
							variant="outline"
							size="sm"
							onClick={() => handleLinkAccount("bitbucket")}
							className="h-8 text-xs font-medium border-border/50 bg-background"
						>
							<LinkIcon className="w-3.5 h-3.5 mr-1.5 opacity-70" />
							Connect
						</Button>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
