"use client";

import { RepositorySelector } from "@/components/repository-selector";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { FormControl, FormField, FormItem } from "@/components/ui/form";
import { GitBranch } from "lucide-react";
import { useFormContext } from "react-hook-form";
import type { VineFormData } from "@/lib/validations/vine-form.schema";

/** Optional app deployment repo — ArgoCD syncs user application manifests from here. */
export function SectionRepositories() {
	const { control } = useFormContext<VineFormData>();

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center gap-2">
					<GitBranch className="h-4 w-4 text-muted-foreground" />
					<CardTitle className="text-base">Application Repository</CardTitle>
				</div>
				<CardDescription className="text-xs">
					Optionally connect a Git repository with your application deployment configs. ArgoCD will sync from it.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="space-y-1.5">
					<Label className="text-xs">App Deployment Repo <span className="text-muted-foreground">(optional)</span></Label>
					<FormField control={control} name="repositories.apps_destination_repo" render={({ field }) => (
						<FormItem>
							<FormControl>
								<RepositorySelector label="" placeholder="Select repository" value={field.value ?? undefined} onChange={(v) => field.onChange(v || null)} />
							</FormControl>
						</FormItem>
					)} />
					<p className="text-[11px] text-muted-foreground">Kubernetes manifests or Helm charts for your applications.</p>
				</div>
			</CardContent>
		</Card>
	);
}
