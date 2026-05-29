"use client";

import { ContainerPlatformSelector } from "@/components/container-platform-selector";
import { EksVersionSelector } from "@/components/configuration/eks-version-selector";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { HelpTooltip } from "./help-tooltip";
import { Plus, Server, Trash2, X } from "lucide-react";
import { useState } from "react";

interface EksAdmin {
	username: string;
	groups: string[];
}

const INSTANCE_TYPE_OPTIONS = [
	"t3.medium",
	"t3.large",
	"t3.xlarge",
	"m5a.large",
	"m5a.xlarge",
	"m5a.2xlarge",
	"m5a.4xlarge",
	"c5.large",
	"c5.xlarge",
	"r5.large",
	"r5.xlarge",
];

interface Props {
	clusterVersion: string;
	onClusterVersionChange: (v: string) => void;
	terraformVersion: string;
	onTerraformVersionChange: (v: string) => void;
	enableKarpenter: boolean;
	onEnableKarpenterChange: (v: boolean) => void;
	platform: string;
	onPlatformChange: (v: string) => void;
	clusterAdmins: EksAdmin[];
	onClusterAdminsChange: (v: EksAdmin[]) => void;
	instanceTypes: string[];
	onInstanceTypesChange: (v: string[]) => void;
	nodeMinSize: number;
	onNodeMinSizeChange: (v: number) => void;
	nodeMaxSize: number;
	onNodeMaxSizeChange: (v: number) => void;
	nodeDesiredSize: number;
	onNodeDesiredSizeChange: (v: number) => void;
}

export function SectionEks({
	clusterVersion,
	onClusterVersionChange,
	terraformVersion,
	onTerraformVersionChange,
	enableKarpenter,
	onEnableKarpenterChange,
	platform,
	onPlatformChange,
	clusterAdmins,
	onClusterAdminsChange,
	instanceTypes,
	onInstanceTypesChange,
	nodeMinSize,
	onNodeMinSizeChange,
	nodeMaxSize,
	onNodeMaxSizeChange,
	nodeDesiredSize,
	onNodeDesiredSizeChange,
}: Props) {
	const [newAdminEmail, setNewAdminEmail] = useState("");

	const nodeSizeError =
		nodeMinSize > nodeDesiredSize || nodeDesiredSize > nodeMaxSize
			? "Must be: min ≤ desired ≤ max"
			: null;

	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

	const addAdmin = () => {
		if (!newAdminEmail.trim() || !emailRegex.test(newAdminEmail.trim())) return;
		onClusterAdminsChange([
			...clusterAdmins,
			{ username: newAdminEmail.trim(), groups: ["system:masters"] },
		]);
		setNewAdminEmail("");
	};

	const removeAdmin = (index: number) => {
		onClusterAdminsChange(clusterAdmins.filter((_, i) => i !== index));
	};

	const addInstanceType = (type: string) => {
		if (!type || instanceTypes.includes(type)) return;
		onInstanceTypesChange([...instanceTypes, type]);
	};

	const removeInstanceType = (type: string) => {
		onInstanceTypesChange(instanceTypes.filter((t) => t !== type));
	};

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center gap-2">
					<Server className="h-4 w-4 text-muted-foreground" />
					<CardTitle className="text-base">Platform & EKS</CardTitle>
				</div>
				<CardDescription className="text-xs">
					Kubernetes cluster configuration, node groups, and auto-scaling.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-5">
				<ContainerPlatformSelector
					selected={platform}
					onSelect={onPlatformChange}
				/>

				<div className="grid md:grid-cols-2 gap-4">
					<div className="space-y-1.5">
						<Label className="text-xs">EKS Version</Label>
						<EksVersionSelector
							value={clusterVersion}
							onChange={onClusterVersionChange}
						/>
					</div>
					<div className="space-y-1.5">
						<Label className="text-xs">Terraform Version</Label>
						<Select value={terraformVersion} onValueChange={onTerraformVersionChange}>
							<SelectTrigger className="h-9 text-sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="1.11.4">1.11.4 (Latest)</SelectItem>
								<SelectItem value="1.10.5">1.10.5</SelectItem>
								<SelectItem value="1.9.8">1.9.8</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</div>

				{/* Node Configuration */}
				<div className="space-y-3">
					<Label className="text-xs font-medium">Node Group</Label>
					<div className="grid md:grid-cols-3 gap-3">
						<div className="space-y-1">
							<Label className="text-[11px] text-muted-foreground">Min Nodes</Label>
							<Input
								type="number"
								min={1}
								max={100}
								value={nodeMinSize}
								onChange={(e) => onNodeMinSizeChange(parseInt(e.target.value) || 2)}
								className={`h-8 text-xs ${nodeSizeError ? "border-destructive" : ""}`}
							/>
						</div>
						<div className="space-y-1">
							<Label className="text-[11px] text-muted-foreground">Desired Nodes</Label>
							<Input
								type="number"
								min={1}
								max={100}
								value={nodeDesiredSize}
								onChange={(e) => onNodeDesiredSizeChange(parseInt(e.target.value) || 2)}
								className={`h-8 text-xs ${nodeSizeError ? "border-destructive" : ""}`}
							/>
						</div>
						<div className="space-y-1">
							<Label className="text-[11px] text-muted-foreground">Max Nodes</Label>
							<Input
								type="number"
								min={1}
								max={100}
								value={nodeMaxSize}
								onChange={(e) => onNodeMaxSizeChange(parseInt(e.target.value) || 5)}
								className={`h-8 text-xs ${nodeSizeError ? "border-destructive" : ""}`}
							/>
						</div>
						{nodeSizeError && (
							<p className="text-[11px] text-destructive col-span-3">{nodeSizeError}</p>
						)}
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
						{instanceTypes.map((type) => (
							<Badge key={type} variant="secondary" className="text-[11px] gap-1 pr-1">
								{type}
								<button
									type="button"
									onClick={() => removeInstanceType(type)}
									className="ml-0.5 hover:bg-muted rounded-full p-0.5"
								>
									<X className="h-2.5 w-2.5" />
								</button>
							</Badge>
						))}
					</div>
					<Select value="" onValueChange={addInstanceType} disabled={instanceTypes.length >= 5}>
						<SelectTrigger className="h-8 text-xs w-48">
							<SelectValue placeholder="Add instance type" />
						</SelectTrigger>
						<SelectContent>
							{INSTANCE_TYPE_OPTIONS.filter((t) => !instanceTypes.includes(t)).map((type) => (
								<SelectItem key={type} value={type} className="text-xs">
									{type}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				{/* Karpenter */}
				<div className="flex items-center justify-between p-3 border border-border/50 rounded-lg">
					<div className="flex items-center gap-1.5">
						<div>
							<p className="text-sm font-medium">Karpenter Auto-Scaling</p>
							<p className="text-[11px] text-muted-foreground">
								Dynamic node provisioning based on workload demand.
							</p>
						</div>
						<HelpTooltip topic="karpenter" />
					</div>
					<Switch checked={enableKarpenter} onCheckedChange={onEnableKarpenterChange} />
				</div>

				{/* Cluster Admins */}
				<div className="space-y-2">
					<div className="flex items-center gap-1.5">
						<Label className="text-xs font-medium">Cluster Admins</Label>
						<HelpTooltip topic="cluster-admins" />
					</div>
					<p className="text-[11px] text-muted-foreground">
						IAM users with system:masters access to the EKS cluster.
					</p>
					{clusterAdmins.length > 0 && (
						<div className="space-y-1.5">
							{clusterAdmins.map((admin, i) => (
								<div key={i} className="flex items-center gap-2 p-2 border border-border/40 rounded-md bg-muted/10">
									<span className="text-xs font-mono flex-1">{admin.username}</span>
									<Badge variant="outline" className="text-[10px]">system:masters</Badge>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										className="h-6 w-6 text-muted-foreground hover:text-destructive"
										onClick={() => removeAdmin(i)}
									>
										<Trash2 className="h-3 w-3" />
									</Button>
								</div>
							))}
						</div>
					)}
					<div className="flex gap-2">
						<Input
							placeholder="user@example.com"
							value={newAdminEmail}
							onChange={(e) => setNewAdminEmail(e.target.value)}
							className="h-8 text-xs"
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									addAdmin();
								}
							}}
						/>
						<Button type="button" variant="outline" size="sm" className="h-8 text-xs shrink-0" onClick={addAdmin}>
							<Plus className="h-3 w-3 mr-1" />
							Add
						</Button>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
