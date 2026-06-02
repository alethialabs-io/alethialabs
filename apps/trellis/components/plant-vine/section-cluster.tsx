"use client";

import { ContainerPlatformSelector } from "./container-platform-selector";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { FormControl, FormField, FormItem } from "@/components/ui/form";
import { HelpTooltip } from "./help-tooltip";
import { useProviderSlug, useProviderMeta, INSTANCE_TYPES, K8S_VERSIONS, AUTOSCALER } from "@/lib/cloud-providers";
import { useCloudProviderStore } from "@/lib/stores/use-cloud-provider-store";
import type { CachedResources } from "@/types/database-custom.types";
import { Server, ShieldCheck, X } from "lucide-react";
import { useFormContext } from "react-hook-form";
import type { VineFormData } from "@/lib/validations/vine-form.schema";

export function SectionCluster() {
	const { control, watch, setValue } = useFormContext<VineFormData>();
	const provider = useProviderSlug();
	const providerMeta = useProviderMeta();
	const instanceTypeOptions = INSTANCE_TYPES[provider];
	const autoscaler = AUTOSCALER[provider];

	const cachedResources = useCloudProviderStore((s) => s.cachedResources);
	const iamUsers = provider === "aws" ? (cachedResources as CachedResources | null)?.iam_users ?? [] : [];

	const instanceTypes = watch("cluster.instance_types") || [];
	const nodeMinSize = watch("cluster.node_min_size") ?? 2;
	const nodeMaxSize = watch("cluster.node_max_size") ?? 5;
	const nodeDesiredSize = watch("cluster.node_desired_size") ?? 2;

	const nodeSizeError = nodeMinSize > nodeDesiredSize || nodeDesiredSize > nodeMaxSize ? "Must be: min ≤ desired ≤ max" : null;

	const addInstanceType = (type: string) => {
		if (!type || instanceTypes.includes(type) || instanceTypes.length >= 5) return;
		setValue("cluster.instance_types", [...instanceTypes, type]);
	};

	const removeInstanceType = (type: string) => {
		setValue("cluster.instance_types", instanceTypes.filter((t: string) => t !== type));
	};

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center gap-2">
					<Server className="h-4 w-4 text-muted-foreground" />
					<CardTitle className="text-base">Platform & Cluster</CardTitle>
				</div>
				<CardDescription className="text-xs">Kubernetes cluster, node groups, and auto-scaling.</CardDescription>
			</CardHeader>
			<CardContent className="space-y-5">
				<ContainerPlatformSelector selected={watch("vine.container_platform" as any) || "standard"} onSelect={(v) => setValue("vine.container_platform" as any, v)} />

				<div className="grid md:grid-cols-2 gap-4">
					<div className="space-y-1.5">
						<Label className="text-xs">{providerMeta.clusterService} Version</Label>
						<FormField control={control} name="cluster.cluster_version" render={({ field }) => (
							<FormItem>
								<Select value={field.value || K8S_VERSIONS[provider][0]} onValueChange={field.onChange}>
									<FormControl><SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger></FormControl>
									<SelectContent>
										{K8S_VERSIONS[provider].map((v) => (
											<SelectItem key={v} value={v} className="text-xs">{v}</SelectItem>
										))}
									</SelectContent>
								</Select>
							</FormItem>
						)} />
					</div>
					<div className="space-y-1.5">
						<Label className="text-xs">Terraform Version</Label>
						<FormField control={control} name="vine.terraform_version" render={({ field }) => (
							<FormItem>
								<Select value={field.value || "1.11.4"} onValueChange={field.onChange}>
									<FormControl><SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger></FormControl>
									<SelectContent>
										<SelectItem value="1.11.4">1.11.4 (Latest)</SelectItem>
										<SelectItem value="1.10.5">1.10.5</SelectItem>
										<SelectItem value="1.9.8">1.9.8</SelectItem>
									</SelectContent>
								</Select>
							</FormItem>
						)} />
					</div>
				</div>

				{/* Node Configuration */}
				<div className="space-y-3">
					<Label className="text-xs font-medium">Node Group</Label>
					<div className="grid md:grid-cols-3 gap-3">
						{(["node_min_size", "node_desired_size", "node_max_size"] as const).map((name) => (
							<FormField key={name} control={control} name={`cluster.${name}` as const} render={({ field }) => (
								<FormItem className="space-y-1">
									<Label className="text-[11px] text-muted-foreground">{name === "node_min_size" ? "Min" : name === "node_desired_size" ? "Desired" : "Max"} Nodes</Label>
									<FormControl>
										<Input type="number" min={1} max={100}
											name={field.name}
											onBlur={field.onBlur}
											value={field.value ?? 2}
											onChange={(e) => field.onChange(parseInt(e.target.value) || 2)}
											className={`h-8 text-xs ${nodeSizeError ? "border-destructive" : ""}`} />
									</FormControl>
								</FormItem>
							)} />
						))}
						{nodeSizeError && <p className="text-[11px] text-destructive col-span-3">{nodeSizeError}</p>}
					</div>
				</div>

				{/* Instance Types */}
				<div className="space-y-2">
					<div className="flex items-center gap-1.5">
						<Label className="text-xs font-medium">Instance Types</Label>
						<HelpTooltip topic="instance-types" />
						<span className="text-[10px] text-muted-foreground">({instanceTypes.length}/5)</span>
					</div>
					<div className="flex flex-wrap gap-1.5 min-h-[32px]">
						{instanceTypes.map((type: string) => (
							<Badge key={type} variant="secondary" className="text-[11px] gap-1 pr-1">
								{type}
								<button type="button" onClick={() => removeInstanceType(type)} className="ml-0.5 hover:bg-muted rounded-full p-0.5"><X className="h-2.5 w-2.5" /></button>
							</Badge>
						))}
					</div>
					<Select value="" onValueChange={addInstanceType} disabled={instanceTypes.length >= 5}>
						<SelectTrigger className="h-8 text-xs w-48"><SelectValue placeholder="Add instance type" /></SelectTrigger>
						<SelectContent>
							{instanceTypeOptions.filter((t) => !instanceTypes.includes(t.value)).map((type) => (
								<SelectItem key={type.value} value={type.value} className="text-xs">
									{type.label} <span className="text-muted-foreground ml-1">{type.cost}</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				{/* Autoscaler */}
				<FormField control={control} name={`cluster.provider_config.${autoscaler.providerConfigKey}` as any} render={({ field }) => (
					<div className="flex items-center justify-between p-3 border border-border/50 rounded-lg">
						<div className="flex items-center gap-1.5">
							<div><p className="text-sm font-medium">{autoscaler.label}</p><p className="text-[11px] text-muted-foreground">{autoscaler.description}</p></div>
						</div>
						<Switch checked={!!field.value} onCheckedChange={field.onChange} />
					</div>
				)} />

				{/* Cluster Admins (AWS only — uses IAM users from cached resources) */}
				{provider === "aws" && iamUsers.length > 0 && (
					<div className="space-y-2">
						<div className="flex items-center gap-1.5">
							<ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
							<Label className="text-xs font-medium">Cluster Admins</Label>
							<HelpTooltip topic="cluster-admins" />
						</div>
						<div className="flex flex-wrap gap-1.5 min-h-[32px]">
							{(watch("cluster.cluster_admins") ?? []).map((admin: { username: string; groups: string[] }) => (
								<Badge key={admin.username} variant="secondary" className="text-[11px] gap-1 pr-1">
									{admin.username}
									<button
										type="button"
										onClick={() => {
											const current = watch("cluster.cluster_admins") ?? [];
											setValue(
												"cluster.cluster_admins",
												current.filter((a: { username: string }) => a.username !== admin.username),
											);
										}}
										className="ml-0.5 hover:bg-muted rounded-full p-0.5"
									>
										<X className="h-2.5 w-2.5" />
									</button>
								</Badge>
							))}
						</div>
						<Select
							value=""
							onValueChange={(username) => {
								const current = watch("cluster.cluster_admins") ?? [];
								if (current.some((a: { username: string }) => a.username === username)) return;
								setValue("cluster.cluster_admins", [
									...current,
									{ username, groups: ["system:masters"] },
								]);
							}}
						>
							<SelectTrigger className="h-8 text-xs w-56">
								<SelectValue placeholder="Add IAM user as admin" />
							</SelectTrigger>
							<SelectContent>
								{iamUsers
									.filter((u) => !(watch("cluster.cluster_admins") ?? []).some((a: { username: string }) => a.username === u.username))
									.map((user) => (
										<SelectItem key={user.username} value={user.username} className="text-xs">
											{user.username}
										</SelectItem>
									))}
							</SelectContent>
						</Select>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
