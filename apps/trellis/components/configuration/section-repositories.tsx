"use client";

import {
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { RepositorySelector } from "@/components/repository-selector";
import { ArgocdTokenSelector } from "./argocd-token-selector";
import { UseFormReturn } from "react-hook-form";
import type { ConfigFormValues } from "./configuration-form";

interface SectionRepositoriesProps {
	form: UseFormReturn<ConfigFormValues>;
}

export function SectionRepositories({ form }: SectionRepositoriesProps) {
	const platform = form.watch("container_platform");
	const enableGitopsDest = form.watch("enable_gitops_destination") ?? false;

	const isPreset = platform === "standard" || platform === "ai-workloads";

	return (
		<Card className="shadow-sm border border-border/40">
			<CardHeader className="bg-muted/5 border-b border-border/40 pb-4">
				<CardTitle className="text-base font-medium">
					Repositories & GitOps
				</CardTitle>
				<CardDescription className="text-xs">
					Configure your Git repositories and ArgoCD authentication.
				</CardDescription>
			</CardHeader>
			<CardContent className="pt-6 space-y-5">
				{/* Side-by-side repo selectors */}
				<div className="grid gap-4 sm:grid-cols-2">
					<FormField
						control={form.control}
						name="env_git_repo"
						render={({ field }) => (
							<FormItem>
								<FormLabel className="text-xs">
									Environment Repository *
								</FormLabel>
								<FormControl>
									<RepositorySelector
										label="Environment Repository"
										value={field.value ?? ""}
										onChange={field.onChange}
									/>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>

					<FormField
						control={form.control}
						name="gitops_destination_repo"
						render={({ field }) => (
							<FormItem>
								<FormLabel className="text-xs">
									GitOps Destination *
								</FormLabel>
								<FormControl>
									<RepositorySelector
										label="GitOps Destination"
										value={field.value ?? ""}
										onChange={field.onChange}
									/>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
				</div>

				{/* Template info for presets */}
				{isPreset && (
					<div className="p-3 rounded-md bg-muted/20 border border-border/40 space-y-1">
						<p className="text-xs font-medium text-foreground">
							Template repositories auto-configured for{" "}
							{platform === "ai-workloads"
								? "AI Workloads"
								: "Standard"}
						</p>
						<p className="text-[11px] text-muted-foreground font-mono truncate">
							{platform === "ai-workloads"
								? "git@github.com:itgix/adp-k8s-aitempl-argoinfra.git"
								: "git@github.com:itgix/adp-k8s-templ-argoinfrasvcs.git"}
						</p>
					</div>
				)}

				{/* Custom template repos */}
				{!isPreset && (
					<div className="grid gap-4 sm:grid-cols-2">
						<FormField
							control={form.control}
							name="applications_template_repo"
							render={({ field }) => (
								<FormItem>
									<FormLabel className="text-xs">
										Applications Template *
									</FormLabel>
									<FormControl>
										<RepositorySelector
											label="Applications Template"
											value={field.value ?? ""}
											onChange={field.onChange}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="applications_destination_repo"
							render={({ field }) => (
								<FormItem>
									<FormLabel className="text-xs">
										Applications Destination *
									</FormLabel>
									<FormControl>
										<RepositorySelector
											label="Applications Destination"
											value={field.value ?? ""}
											onChange={field.onChange}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
					</div>
				)}

				{/* ArgoCD auth */}
				<FormField
					control={form.control}
					name="argocd_git_provider"
					render={({ field }) => (
						<FormItem>
							<FormLabel className="text-xs">
								ArgoCD Git Authentication *
							</FormLabel>
							<FormControl>
								<ArgocdTokenSelector
									value={field.value ?? ""}
									onChange={field.onChange}
									manualToken={
										form.watch("gitops_argocd_token") ?? ""
									}
									onManualTokenChange={(token) =>
										form.setValue(
											"gitops_argocd_token",
											token,
										)
									}
								/>
							</FormControl>
							<FormMessage />
						</FormItem>
					)}
				/>

				{/* Optional app destination */}
				<div className="flex items-center justify-between p-3 rounded-md border border-border/40">
					<div>
						<p className="text-sm font-medium">
							Application Destination
						</p>
						<p className="text-xs text-muted-foreground">
							Separate token for application repositories
						</p>
					</div>
					<Switch
						checked={enableGitopsDest}
						onCheckedChange={(checked) =>
							form.setValue(
								"enable_gitops_destination",
								checked,
							)
						}
					/>
				</div>

				{enableGitopsDest && (
					<div className="pl-3 border-l-2 border-border/40">
						<FormField
							control={form.control}
							name="gitops_app_token"
							render={({ field }) => (
								<FormItem>
									<FormLabel className="text-xs">
										Application Git Token
									</FormLabel>
									<FormControl>
										<Input
											type="password"
											placeholder="Git access token for applications repo"
											className="h-9 text-sm"
											value={field.value ?? ""}
											onChange={field.onChange}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
