"use client";

import { ContainerPlatformSelector } from "./container-platform-selector";
import { EksVersionSelector } from "./eks-version-selector";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { FormControl, FormField, FormItem } from "@/components/ui/form";
import { HelpTooltip } from "./help-tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { getClusterAdmins, createClusterAdmin, type ClusterAdminOption } from "@/app/server/actions/eks-admins";
import { useProviderSlug, useProviderMeta, INSTANCE_TYPES, K8S_VERSIONS, AUTOSCALER } from "@/lib/cloud-providers";
import { ChevronsUpDown, Plus, Server, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useFormContext } from "react-hook-form";
import type { VineFormData } from "@/lib/validations/vine-form.schema";

export function SectionCluster() {
	const { control, watch, setValue } = useFormContext<VineFormData>();
	const provider = useProviderSlug();
	const providerMeta = useProviderMeta();
	const instanceTypeOptions = INSTANCE_TYPES[provider];
	const autoscaler = AUTOSCALER[provider];
	const [savedAdmins, setSavedAdmins] = useState<ClusterAdminOption[]>([]);
	const [comboOpen, setComboOpen] = useState(false);
	const [comboSearch, setComboSearch] = useState("");

	useEffect(() => { getClusterAdmins().then(setSavedAdmins); }, []);

	const clusterAdmins = watch("cluster.cluster_admins") || [];
	const instanceTypes = watch("cluster.instance_types") || [];
	const nodeMinSize = watch("cluster.node_min_size") ?? 2;
	const nodeMaxSize = watch("cluster.node_max_size") ?? 5;
	const nodeDesiredSize = watch("cluster.node_desired_size") ?? 2;

	const nodeSizeError = nodeMinSize > nodeDesiredSize || nodeDesiredSize > nodeMaxSize ? "Must be: min ≤ desired ≤ max" : null;
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

	const addAdminByEmail = async (email: string) => {
		const trimmed = email.trim().toLowerCase();
		if (!trimmed || !emailRegex.test(trimmed)) return;
		if (clusterAdmins.some((a: any) => a.username === trimmed)) return;
		setValue("cluster.cluster_admins", [...clusterAdmins, { username: trimmed, groups: ["system:masters"] }]);
		const saved = await createClusterAdmin(trimmed);
		if (saved && !savedAdmins.some((a) => a.email === trimmed)) setSavedAdmins((prev) => [...prev, saved]);
		setComboSearch(""); setComboOpen(false);
	};

	const removeAdmin = (index: number) => {
		setValue("cluster.cluster_admins", clusterAdmins.filter((_: any, i: number) => i !== index));
	};

	const availableAdmins = savedAdmins.filter((a) => !clusterAdmins.some((ca: any) => ca.username === a.email));

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
							<FormItem><EksVersionSelector value={field.value || "1.32"} onChange={field.onChange} /></FormItem>
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
										<Input type="number" min={1} max={100} {...field} value={Number(field.value) ?? 2}
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

				{/* Cluster Admins */}
				<div className="space-y-2">
					<div className="flex items-center gap-1.5">
						<Label className="text-xs font-medium">Cluster Admins</Label>
						<HelpTooltip topic="cluster-admins" />
					</div>
					{clusterAdmins.length > 0 && (
						<div className="space-y-1.5">
							{clusterAdmins.map((admin: any, i: number) => (
								<div key={i} className="flex items-center gap-2 p-2 border border-border/40 rounded-md bg-muted/10">
									<span className="text-xs font-mono flex-1">{admin.username}</span>
									<Badge variant="outline" className="text-[10px]">system:masters</Badge>
									<Button type="button" variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={() => removeAdmin(i)}>
										<Trash2 className="h-3 w-3" />
									</Button>
								</div>
							))}
						</div>
					)}
					<Popover open={comboOpen} onOpenChange={setComboOpen}>
						<PopoverTrigger asChild>
							<Button type="button" variant="outline" role="combobox" aria-expanded={comboOpen} className="h-8 text-xs justify-between w-full font-normal text-muted-foreground">
								Search or add admin...
								<ChevronsUpDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
							</Button>
						</PopoverTrigger>
						<PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
							<Command>
								<CommandInput placeholder="Type email..." value={comboSearch} onValueChange={setComboSearch} className="text-xs" />
								<CommandList>
									<CommandEmpty className="py-2 px-3">
										{comboSearch && emailRegex.test(comboSearch.trim()) ? (
											<button type="button" onClick={() => addAdminByEmail(comboSearch)} className="flex items-center gap-1.5 text-xs text-foreground w-full">
												<Plus className="h-3 w-3" />Add "{comboSearch.trim()}"
											</button>
										) : (
											<span className="text-xs text-muted-foreground">{comboSearch ? "Enter a valid email" : "No saved admins"}</span>
										)}
									</CommandEmpty>
									{availableAdmins.length > 0 && (
										<CommandGroup heading="Saved admins">
											{availableAdmins.map((admin) => (
												<CommandItem key={admin.id} value={admin.email} onSelect={() => addAdminByEmail(admin.email)} className="text-xs">{admin.email}</CommandItem>
											))}
										</CommandGroup>
									)}
									{comboSearch && emailRegex.test(comboSearch.trim()) && !savedAdmins.some((a) => a.email === comboSearch.trim().toLowerCase()) && (
										<CommandGroup heading="New">
											<CommandItem value={`add-${comboSearch}`} onSelect={() => addAdminByEmail(comboSearch)} className="text-xs">
												<Plus className="h-3 w-3 mr-1.5" />Add "{comboSearch.trim()}"
											</CommandItem>
										</CommandGroup>
									)}
								</CommandList>
							</Command>
						</PopoverContent>
					</Popover>
				</div>
			</CardContent>
		</Card>
	);
}
