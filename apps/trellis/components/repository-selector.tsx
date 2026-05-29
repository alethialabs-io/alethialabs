"use client";

import { GitProviderIcon } from "@/components/git-provider-icon";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { PublicGitProvider } from "@/lib/validations/db.schemas";
import { env } from "next-runtime-env";

import { fetchRepositoriesByProvider } from "@/app/server/actions/git/repositories";
import { Repository } from "@/app/server/actions/git/types";
import { getLinkedProviders } from "@/app/server/actions/identities";
import { useRepositoryContext } from "@/components/configuration/repository-context";
import { AlertCircle, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface RepositorySelectorProps {
	value: string | undefined;
	onChange: (value: string) => void;
	label: string;
	placeholder?: string;
	required?: boolean;
}

export function RepositorySelector({
	value,
	onChange,
	label,
	placeholder,
	required,
}: RepositorySelectorProps) {
	const sharedCtx = useRepositoryContext();
	const [repositories, setRepositories] = useState<Repository[]>([]);
	const [loading, setLoading] = useState(false);
	const [fetchingRepos, setFetchingRepos] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [authRecoveryProvider, setAuthRecoveryProvider] =
		useState<PublicGitProvider | null>(null);
	const [linkedProviders, setLinkedProviders] = useState<PublicGitProvider[]>(
		[],
	);
	const [selectedProvider, setSelectedProvider] =
		useState<PublicGitProvider | null>(null);
	const [showLinkOptions, setShowLinkOptions] = useState(false);
	const [isManual, setIsManual] = useState(false);
	const [initialValue] = useState(value);
	const [open, setOpen] = useState(false);

	// When shared context exists, use its data instead of fetching independently
	useEffect(() => {
		if (!sharedCtx) return;
		setLinkedProviders(sharedCtx.linkedProviders);
		setLoading(sharedCtx.loadingProviders);

		if (sharedCtx.linkedProviders.length > 0 && !selectedProvider) {
			let provider = sharedCtx.linkedProviders[0];
			if (initialValue) {
				if (initialValue.includes("github.com")) provider = "github";
				else if (initialValue.includes("gitlab.com")) provider = "gitlab";
				else if (initialValue.includes("bitbucket.org")) provider = "bitbucket";
			}
			if (sharedCtx.linkedProviders.includes(provider)) {
				setSelectedProvider(provider);
			} else {
				setSelectedProvider(sharedCtx.linkedProviders[0]);
			}
		}
	}, [sharedCtx?.linkedProviders, sharedCtx?.loadingProviders]);

	useEffect(() => {
		if (!sharedCtx || !selectedProvider) return;
		const repos = sharedCtx.reposByProvider[selectedProvider];
		if (repos) {
			setRepositories(repos);
			setFetchingRepos(false);
		} else {
			setFetchingRepos(sharedCtx.loadingRepos);
			sharedCtx.fetchRepos(selectedProvider);
		}
	}, [sharedCtx?.reposByProvider, selectedProvider, sharedCtx?.loadingRepos]);

	const loadInitialData = useCallback(async () => {
		if (sharedCtx) return; // Skip — using shared context
		setLoading(true);
		setError(null);
		try {
			const providers = await getLinkedProviders();
			setLinkedProviders(providers);

			if (providers.length > 0) {
				let initialProvider = providers[0];
				if (initialValue) {
					if (initialValue.includes("github.com"))
						initialProvider = "github";
					else if (initialValue.includes("gitlab.com"))
						initialProvider = "gitlab";
					else if (initialValue.includes("bitbucket.org"))
						initialProvider = "bitbucket";
				}

				if (providers.includes(initialProvider)) {
					setSelectedProvider(initialProvider as PublicGitProvider);
					await fetchRepositories(
						initialProvider as PublicGitProvider,
					);
				} else {
					setSelectedProvider(providers[0] as PublicGitProvider);
					await fetchRepositories(providers[0] as PublicGitProvider);
				}
			}
		} catch (err) {
			console.error("Error loading linked providers:", err);
			setError("Failed to load linked accounts");
		} finally {
			setLoading(false);
		}
	}, [initialValue, sharedCtx]);

	useEffect(() => {
		if (!sharedCtx) loadInitialData();
	}, [loadInitialData, sharedCtx]);

	const fetchRepositories = async (providerName: PublicGitProvider) => {
		setFetchingRepos(true);
		setError(null);
		setAuthRecoveryProvider(null);
		let recoveryProvider: PublicGitProvider | null = null;
		try {
			const data = await fetchRepositoriesByProvider(providerName);
			if (data.error) {
				if (
					data.authErrorCode &&
					data.authProvider &&
					(data.authErrorCode === "token_expired" ||
						data.authErrorCode === "unauthorized" ||
						data.authErrorCode === "missing_token")
				) {
					setAuthRecoveryProvider(data.authProvider);
					recoveryProvider = data.authProvider;
				}
				throw new Error(data.error);
			}

			setRepositories(data.repositories || []);
		} catch (err) {
			console.error(`Error fetching ${providerName} repositories:`, err);
			setError(
				recoveryProvider
					? `Authentication with ${recoveryProvider} failed or expired. Relink your account and try again.`
					: err instanceof Error
						? err.message
						: "Failed to fetch repositories",
			);
			setRepositories([]);
		} finally {
			setFetchingRepos(false);
		}
	};

	const handleProviderChange = async (provider: PublicGitProvider) => {
		setSelectedProvider(provider);
		onChange(""); // Reset selected repository when provider changes
		await fetchRepositories(provider);
	};

	const handleLinkAccount = async (providerName: PublicGitProvider) => {
		try {
			const supabase = await createClient();

			// Verify session is valid before linking
			const {
				data: { user },
				error: userError,
			} = await supabase.auth.getUser();

			if (userError || !user) {
				console.error("Session invalid, signing out:", userError);
				await supabase.auth.signOut();
				window.location.href = "/auth/signin"; // Redirect to login
				return;
			}

			const { error } = await supabase.auth.linkIdentity({
				provider: providerName,
				options: {
					redirectTo: `${env("NEXT_PUBLIC_APP_URL") || window.location.origin}/api/auth/callback?next=/dashboard/configure&provider=${providerName}`,
					scopes: providerName === "github" ? "repo" : providerName === "gitlab" ? "read_api read_user read_repository read_registry openid profile email" : undefined,
				},
			});

			if (error) throw error;
		} catch (err) {
			console.error(`Error linking ${providerName}:`, err);
			setError(
				`Failed to link ${providerName} account. Please try signing out and back in.`,
			);
		}
	};

	if (loading) {
		return (
			<div className="space-y-2 animate-pulse">
				<div className="h-4 w-24 bg-muted rounded" />
				<div className="h-10 w-full bg-muted rounded" />
			</div>
		);
	}

	if (linkedProviders.length === 0 && !isManual) {
		return (
			<div className="space-y-3 border rounded-lg p-4 bg-muted/30">
				<div className="flex items-center gap-2 text-sm font-medium">
					<AlertCircle className="h-4 w-4 text-yellow-600" />
					<span>No Git accounts linked</span>
				</div>
				<p className="text-sm text-muted-foreground">
					Link an account to select repositories automatically, or
					enter the URL manually.
				</p>
				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => handleLinkAccount("github")}
					>
						<GitProviderIcon provider="github" className="mr-2" />{" "}
						Link GitHub
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => handleLinkAccount("gitlab")}
					>
						<GitProviderIcon provider="gitlab" className="mr-2" />{" "}
						Link GitLab
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => handleLinkAccount("bitbucket")}
					>
						<GitProviderIcon
							provider="bitbucket"
							className="mr-2"
						/>{" "}
						Link Bitbucket
					</Button>
					<div className="w-full mt-2">
						<Button
							type="button"
							variant="link"
							size="sm"
							className="text-xs px-0 text-muted-foreground hover:text-foreground"
							onClick={() => setIsManual(true)}
						>
							Or enter repository URL manually
						</Button>
					</div>
				</div>
			</div>
		);
	}

	if (isManual) {
		return (
			<div className="space-y-3">
				<div className="flex items-center justify-between">
					<label className="text-sm font-medium">
						{label}
						{required && (
							<span className="text-red-500 ml-1">*</span>
						)}
					</label>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => setIsManual(false)}
						className="text-xs text-muted-foreground h-auto py-1"
					>
						Use provider select
					</Button>
				</div>
				<Input
					value={value || ""}
					onChange={(e) => onChange(e.target.value)}
					placeholder="https://github.com/organization/repository"
					className="font-mono text-sm"
				/>
				<p className="text-xs text-muted-foreground">
					Enter the full HTTP URL to your Git repository.
				</p>
			</div>
		);
	}

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<label className="text-sm font-medium">
					{label}
					{required && <span className="text-red-500 ml-1">*</span>}
				</label>
				<div className="flex items-center gap-2">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => setIsManual(true)}
						className="text-xs text-muted-foreground h-auto py-1 mr-2"
					>
						Enter URL manually
					</Button>
					{authRecoveryProvider ? (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() =>
								handleLinkAccount(authRecoveryProvider)
							}
							className="text-xs text-destructive hover:text-destructive h-auto py-1"
						>
							<GitProviderIcon
								provider={authRecoveryProvider}
								className="mr-1"
								size={14}
							/>
							Relink
						</Button>
					) : (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() =>
								selectedProvider &&
								fetchRepositories(selectedProvider)
							}
							disabled={fetchingRepos || !selectedProvider}
							title="Refresh repositories"
						>
							<RefreshCw
								className={`w-4 h-4 ${fetchingRepos ? "animate-spin" : ""}`}
							/>
						</Button>
					)}
				</div>
			</div>

			<div className={cn(
				"flex w-full items-center gap-0 rounded-md border bg-transparent shadow-sm overflow-hidden focus-within:ring-1 focus-within:ring-ring",
				error ? "border-destructive/50" : "border-input"
			)}>
				{/* Provider Selection (Icon Only) */}
				<Select
					value={selectedProvider || ""}
					onValueChange={(val) =>
						handleProviderChange(val as PublicGitProvider)
					}
				>
					<SelectTrigger className="w-[50px] shrink-0 rounded-none border-0 border-r bg-muted/20 focus:ring-0 focus:ring-offset-0 justify-center px-0">
						{selectedProvider ? (
							<GitProviderIcon
								provider={selectedProvider}
								size={18}
							/>
						) : (
							<SelectValue />
						)}
					</SelectTrigger>
					<SelectContent>
						{linkedProviders.map((p) => (
							<SelectItem key={p} value={p}>
								<div className="flex items-center gap-2">
									<GitProviderIcon provider={p} />
									<span className="capitalize">{p}</span>
								</div>
							</SelectItem>
						))}
						<div className="border-t my-1" />
						<Button
							variant="ghost"
							className="w-full justify-start text-xs h-8 px-2 font-normal"
							onClick={(e) => {
								e.stopPropagation();
								setShowLinkOptions(!showLinkOptions);
							}}
						>
							<Plus className="w-3 h-3 mr-2" /> Link another
						</Button>
					</SelectContent>
				</Select>

				{/* Repository Selection with Combobox or Error State */}
				{error ? (
					<div className="flex-1 flex items-center gap-2 px-3 min-h-9">
						<AlertCircle className="w-3.5 h-3.5 shrink-0 text-destructive" />
						<span className="text-sm text-destructive truncate">
							{authRecoveryProvider
								? "Session expired — relink to continue"
								: error}
						</span>
					</div>
				) : (
					<Popover open={open} onOpenChange={setOpen}>
						<PopoverTrigger asChild>
							<Button
								variant="ghost"
								role="combobox"
								aria-expanded={open}
								className={cn(
									"flex-1 justify-start rounded-none border-0 hover:bg-transparent font-normal px-3",
									!value && "text-muted-foreground",
									fetchingRepos && "opacity-50"
								)}
								disabled={fetchingRepos || repositories.length === 0}
							>
								{value ? (
									<div className="flex items-center gap-2 w-full truncate text-left">
										<span className="font-mono text-sm truncate max-w-[calc(100%-40px)]">
											{repositories.find((r) => r.url === value)?.full_name || value}
										</span>
										{repositories.find((r) => r.url === value)?.private && (
											<span className="text-[10px] bg-yellow-100 text-yellow-800 px-1 py-0 rounded shrink-0">
												Private
											</span>
										)}
									</div>
								) : fetchingRepos ? (
									"Fetching repositories..."
								) : repositories.length === 0 ? (
									"No repositories found"
								) : (
									placeholder || "Select repository..."
								)}
							</Button>
						</PopoverTrigger>
						<PopoverContent className="w-[400px] p-0" align="start">
							<Command>
								<CommandInput placeholder="Search repositories..." />
								<CommandList>
									<CommandEmpty>No repository found.</CommandEmpty>
									<CommandGroup>
										{repositories.map((repo) => (
											<CommandItem
												key={repo.id}
												value={repo.full_name}
												onSelect={() => {
													onChange(repo.url);
													setOpen(false);
												}}
											>
												<div className="flex w-full items-center justify-between">
													<span className="font-mono text-sm truncate">
														{repo.full_name}
													</span>
													{repo.private && (
														<span className="text-[10px] bg-yellow-100 text-yellow-800 px-1 py-0 rounded shrink-0 ml-2">
															Private
														</span>
													)}
												</div>
											</CommandItem>
										))}
									</CommandGroup>
								</CommandList>
							</Command>
						</PopoverContent>
					</Popover>
				)}
			</div>

			{showLinkOptions && (
				<div className="flex flex-wrap gap-2 p-2 border rounded-md bg-muted/20 animate-in fade-in slide-in-from-top-1">
					<p className="text-[10px] uppercase font-bold text-muted-foreground w-full mb-1">
						Link Platform
					</p>
					{!linkedProviders.includes("github") && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="h-7 text-xs"
							onClick={() => handleLinkAccount("github")}
						>
							<GitProviderIcon
								provider="github"
								className="mr-1"
							/>{" "}
							GitHub
						</Button>
					)}
					{!linkedProviders.includes("gitlab") && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="h-7 text-xs"
							onClick={() => handleLinkAccount("gitlab")}
						>
							<GitProviderIcon
								provider="gitlab"
								className="mr-1"
							/>{" "}
							GitLab
						</Button>
					)}
					{!linkedProviders.includes("bitbucket") && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="h-7 text-xs"
							onClick={() => handleLinkAccount("bitbucket")}
						>
							<GitProviderIcon
								provider="bitbucket"
								className="mr-1"
							/>{" "}
							Bitbucket
						</Button>
					)}
				</div>
			)}

			{repositories.length === 0 &&
				!fetchingRepos &&
				!error &&
				selectedProvider && (
					<p className="text-xs text-muted-foreground italic px-1">
						No repositories found for this account.
					</p>
				)}
		</div>
	);
}
