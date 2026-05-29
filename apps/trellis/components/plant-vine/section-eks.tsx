"use client";

import { ContainerPlatformSelector } from "@/components/container-platform-selector";
import { EksVersionSelector } from "@/components/configuration/eks-version-selector";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Server } from "lucide-react";

interface Props {
	clusterVersion: string;
	onClusterVersionChange: (v: string) => void;
	terraformVersion: string;
	onTerraformVersionChange: (v: string) => void;
	enableKarpenter: boolean;
	onEnableKarpenterChange: (v: boolean) => void;
	platform: string;
	onPlatformChange: (v: string) => void;
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
}: Props) {
	return (
		<Card>
			<CardHeader>
				<div className="flex items-center gap-2">
					<Server className="h-4 w-4 text-muted-foreground" />
					<CardTitle className="text-base">Platform & EKS</CardTitle>
				</div>
				<CardDescription className="text-xs">
					Choose your container platform, Kubernetes version, and scaling options.
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

				<div className="flex items-center justify-between p-3 border border-border/50 rounded-lg">
					<div>
						<p className="text-sm font-medium">Karpenter Auto-Scaling</p>
						<p className="text-[11px] text-muted-foreground">
							Dynamic node provisioning based on workload demand.
						</p>
					</div>
					<Switch checked={enableKarpenter} onCheckedChange={onEnableKarpenterChange} />
				</div>
			</CardContent>
		</Card>
	);
}
