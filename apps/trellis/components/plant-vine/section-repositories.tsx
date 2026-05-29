"use client";

import { RepositorySelector } from "@/components/repository-selector";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { CheckCircle2, GitBranch } from "lucide-react";

interface Props {
	platform: string;
	envDestinationRepo: string | null;
	onEnvDestinationRepoChange: (v: string | null) => void;
	gitopsDestinationRepo: string | null;
	onGitopsDestinationRepoChange: (v: string | null) => void;
	appsDestinationRepo: string | null;
	onAppsDestinationRepoChange: (v: string | null) => void;
}

export function SectionRepositories({
	platform,
	envDestinationRepo,
	onEnvDestinationRepoChange,
	gitopsDestinationRepo,
	onGitopsDestinationRepoChange,
	appsDestinationRepo,
	onAppsDestinationRepoChange,
}: Props) {
	const isPreset = platform === "standard" || platform === "ai-workloads";
	const templateRepo =
		platform === "ai-workloads"
			? "git@github.com:itgix/adp-k8s-aitempl-argoinfra.git"
			: "git@github.com:itgix/adp-k8s-templ-argoinfrasvcs.git";

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center gap-2">
					<GitBranch className="h-4 w-4 text-muted-foreground" />
					<CardTitle className="text-base">Repositories</CardTitle>
				</div>
				<CardDescription className="text-xs">
					Template repositories are auto-configured. Select your destination repositories.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{isPreset && (
					<div className="p-3 rounded-lg bg-muted/20 border border-border/40 space-y-2">
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							<CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
							<span>Template repositories auto-configured for <strong className="text-foreground capitalize">{platform}</strong></span>
						</div>
						<div className="grid md:grid-cols-2 gap-2">
							<div className="text-[11px]">
								<span className="text-muted-foreground">Infra: </span>
								<code className="text-foreground">adp-tf-envtempl-standard</code>
							</div>
							<div className="text-[11px]">
								<span className="text-muted-foreground">GitOps: </span>
								<code className="text-foreground">{templateRepo.split("/").pop()?.replace(".git", "")}</code>
							</div>
						</div>
					</div>
				)}

				<div className="grid md:grid-cols-2 gap-4">
					<div className="space-y-1.5">
						<Label className="text-xs">Environment Repository</Label>
						<RepositorySelector
							label=""
							placeholder="Select env repository"
							value={envDestinationRepo ?? undefined}
							onChange={(v) => onEnvDestinationRepoChange(v || null)}
						/>
					</div>
					<div className="space-y-1.5">
						<Label className="text-xs">GitOps Repository</Label>
						<RepositorySelector
							label=""
							placeholder="Select GitOps repository"
							value={gitopsDestinationRepo ?? undefined}
							onChange={(v) => onGitopsDestinationRepoChange(v || null)}
						/>
					</div>
				</div>

				<div className="space-y-1.5">
					<Label className="text-xs">Applications Repository (optional)</Label>
					<RepositorySelector
						label=""
						placeholder="Select applications repository"
						value={appsDestinationRepo ?? undefined}
						onChange={(v) => onAppsDestinationRepoChange(v || null)}
					/>
				</div>
			</CardContent>
		</Card>
	);
}
