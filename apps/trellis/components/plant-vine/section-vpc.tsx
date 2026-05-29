"use client";

import type { CachedAwsResources } from "@/app/server/actions/aws/resources";
import { Badge } from "@/components/ui/badge";
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
import { Network } from "lucide-react";

interface VpcInfo {
	ID: string;
	CIDR: string;
	Name: string;
	IsDefault: boolean;
}

interface Props {
	provisionVpc: boolean;
	onProvisionVpcChange: (v: boolean) => void;
	vpcId: string | null;
	onVpcIdChange: (v: string | null) => void;
	vpcCidr: string;
	onVpcCidrChange: (v: string) => void;
	singleNatGateway: boolean;
	onSingleNatGatewayChange: (v: boolean) => void;
	region: string;
	awsResources: CachedAwsResources | null;
}

export function SectionVpc({
	provisionVpc,
	onProvisionVpcChange,
	vpcId,
	onVpcIdChange,
	vpcCidr,
	onVpcCidrChange,
	singleNatGateway,
	onSingleNatGatewayChange,
	region,
	awsResources,
}: Props) {
	const vpcsForRegion = (awsResources?.vpcs as Record<string, VpcInfo[]>)?.[region] || [];

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<Network className="h-4 w-4 text-muted-foreground" />
						<CardTitle className="text-base">VPC & Networking</CardTitle>
					</div>
				</div>
				<CardDescription className="text-xs">
					Create a new VPC or use an existing one from your account.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="flex gap-2">
					<button
						type="button"
						onClick={() => onProvisionVpcChange(true)}
						className={`flex-1 p-3 rounded-lg border text-left transition-all text-sm ${
							provisionVpc
								? "border-foreground bg-muted/20 font-medium"
								: "border-border/50 text-muted-foreground hover:border-border"
						}`}
					>
						Create New VPC
					</button>
					<button
						type="button"
						onClick={() => onProvisionVpcChange(false)}
						disabled={vpcsForRegion.length === 0}
						className={`flex-1 p-3 rounded-lg border text-left transition-all text-sm ${
							!provisionVpc
								? "border-foreground bg-muted/20 font-medium"
								: "border-border/50 text-muted-foreground hover:border-border"
						} ${vpcsForRegion.length === 0 ? "opacity-50 cursor-not-allowed" : ""}`}
					>
						Use Existing VPC
						{!region && (
							<span className="block text-[10px] text-muted-foreground/60 mt-0.5">
								Select a region first
							</span>
						)}
						{region && vpcsForRegion.length === 0 && (
							<span className="block text-[10px] text-muted-foreground/60 mt-0.5">
								No VPCs found in {region}
							</span>
						)}
					</button>
				</div>

				{provisionVpc ? (
					<div className="grid md:grid-cols-2 gap-4">
						<div className="space-y-1.5">
							<Label className="text-xs">VPC CIDR Block</Label>
							<Input
								placeholder="10.0.0.0/16"
								value={vpcCidr}
								onChange={(e) => onVpcCidrChange(e.target.value)}
								className="h-9 text-sm font-mono"
							/>
						</div>
						<div className="space-y-1.5">
							<Label className="text-xs">NAT Gateway</Label>
							<Select
								value={singleNatGateway ? "single" : "ha"}
								onValueChange={(v) => onSingleNatGatewayChange(v === "single")}
							>
								<SelectTrigger className="h-9 text-sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="single">
										Single (cost-effective)
									</SelectItem>
									<SelectItem value="ha">
										Per-AZ (high availability)
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
					</div>
				) : (
					<div className="space-y-1.5">
						<Label className="text-xs">Select VPC</Label>
						<Select value={vpcId || ""} onValueChange={(v) => onVpcIdChange(v)}>
							<SelectTrigger className="h-9 text-sm">
								<SelectValue placeholder="Choose a VPC" />
							</SelectTrigger>
							<SelectContent>
								{vpcsForRegion.map((vpc: VpcInfo) => (
									<SelectItem key={vpc.ID} value={vpc.ID}>
										<span className="font-mono">{vpc.ID}</span>
										<span className="text-muted-foreground ml-2">
											{vpc.CIDR}
										</span>
										{vpc.Name && (
											<span className="text-muted-foreground ml-1">
												— {vpc.Name}
											</span>
										)}
										{vpc.IsDefault && (
											<Badge variant="outline" className="ml-2 text-[10px]">
												Default
											</Badge>
										)}
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
