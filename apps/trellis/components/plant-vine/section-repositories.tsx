"use client";

import { RepositorySelector } from "@/components/repository-selector";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { FormControl, FormField, FormItem } from "@/components/ui/form";
import { GitBranch } from "lucide-react";
import { useFormContext } from "react-hook-form";
import type { VineFormData } from "@/lib/validations/vine-form.schema";

/** Git destination repository configuration — where Grape pushes generated infrastructure code. */
export function SectionRepositories() {
	const { control } = useFormContext<VineFormData>();

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center gap-2">
					<GitBranch className="h-4 w-4 text-muted-foreground" />
					<CardTitle className="text-base">Git Repositories</CardTitle>
				</div>
				<CardDescription className="text-xs">
					Select the Git repositories where Grape will push your generated infrastructure code.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="grid md:grid-cols-2 gap-4">
					<div className="space-y-1.5">
						<Label className="text-xs">Infrastructure Repo <span className="text-destructive">*</span></Label>
						<FormField control={control} name="repositories.env_destination_repo" render={({ field }) => (
							<FormItem>
								<FormControl>
									<RepositorySelector label="" placeholder="Select repository" value={field.value ?? undefined} onChange={(v) => field.onChange(v || null)} />
								</FormControl>
							</FormItem>
						)} />
						<p className="text-[11px] text-muted-foreground">Terraform configs and state.</p>
					</div>
					<div className="space-y-1.5">
						<Label className="text-xs">GitOps Repo <span className="text-destructive">*</span></Label>
						<FormField control={control} name="repositories.gitops_destination_repo" render={({ field }) => (
							<FormItem>
								<FormControl>
									<RepositorySelector label="" placeholder="Select repository" value={field.value ?? undefined} onChange={(v) => field.onChange(v || null)} />
								</FormControl>
							</FormItem>
						)} />
						<p className="text-[11px] text-muted-foreground">ArgoCD application manifests.</p>
					</div>
				</div>

				<div className="space-y-1.5">
					<Label className="text-xs">Applications Repo <span className="text-muted-foreground">(optional)</span></Label>
					<FormField control={control} name="repositories.apps_destination_repo" render={({ field }) => (
						<FormItem>
							<FormControl>
								<RepositorySelector label="" placeholder="Select repository" value={field.value ?? undefined} onChange={(v) => field.onChange(v || null)} />
							</FormControl>
						</FormItem>
					)} />
					<p className="text-[11px] text-muted-foreground">Application deployment configs.</p>
				</div>
			</CardContent>
		</Card>
	);
}
