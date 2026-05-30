"use client";

import { RepositorySelector } from "@/components/repository-selector";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { FormControl, FormField, FormItem } from "@/components/ui/form";
import { HelpTooltip } from "./help-tooltip";
import { CheckCircle2, GitBranch } from "lucide-react";
import { useFormContext } from "react-hook-form";
import type { VineFormData } from "@/lib/validations/vine-form.schema";

export function SectionRepositories() {
	const { control, watch } = useFormContext<VineFormData>();
	// Platform is not in the vine schema — read from a watched "extra" field or the EKS section
	// For now, we check if gitops_template_repo contains "aitempl" to determine AI mode
	const templateRepo = watch("repositories.gitops_template_repo") || "";
	const isPreset = true; // Templates are always auto-configured

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
				<div className="p-3 rounded-lg bg-muted/20 border border-border/40 space-y-2">
					<div className="flex items-center gap-2 text-xs text-muted-foreground">
						<CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
						<span>Template repositories auto-configured</span>
					</div>
					<div className="grid md:grid-cols-2 gap-2">
						<div className="text-[11px]">
							<span className="text-muted-foreground">Infra: </span>
							<code className="text-foreground">adp-tf-envtempl-standard</code>
						</div>
						<div className="text-[11px]">
							<span className="text-muted-foreground">GitOps: </span>
							<code className="text-foreground">{templateRepo.includes("aitempl") ? "adp-k8s-aitempl-argoinfra" : "adp-k8s-templ-argoinfrasvcs"}</code>
						</div>
					</div>
				</div>

				<div className="grid md:grid-cols-2 gap-4">
					<div className="space-y-1.5">
						<Label className="text-xs">Environment Repository <span className="text-destructive">*</span></Label>
						<FormField control={control} name="repositories.env_destination_repo" render={({ field }) => (
							<FormItem>
								<FormControl>
									<RepositorySelector label="" placeholder="Select env repository" value={field.value ?? undefined} onChange={(v) => field.onChange(v || null)} />
								</FormControl>
							</FormItem>
						)} />
						<p className="text-[11px] text-muted-foreground">Terraform infrastructure configs.</p>
					</div>
					<div className="space-y-1.5">
						<Label className="text-xs">GitOps Repository <span className="text-destructive">*</span></Label>
						<FormField control={control} name="repositories.gitops_destination_repo" render={({ field }) => (
							<FormItem>
								<FormControl>
									<RepositorySelector label="" placeholder="Select GitOps repository" value={field.value ?? undefined} onChange={(v) => field.onChange(v || null)} />
								</FormControl>
							</FormItem>
						)} />
						<p className="text-[11px] text-muted-foreground">ArgoCD manifests.</p>
					</div>
				</div>

				<div className="space-y-1.5">
					<Label className="text-xs">Applications Repository (optional)</Label>
					<FormField control={control} name="repositories.apps_destination_repo" render={({ field }) => (
						<FormItem>
							<FormControl>
								<RepositorySelector label="" placeholder="Select applications repository" value={field.value ?? undefined} onChange={(v) => field.onChange(v || null)} />
							</FormControl>
						</FormItem>
					)} />
				</div>
			</CardContent>
		</Card>
	);
}
