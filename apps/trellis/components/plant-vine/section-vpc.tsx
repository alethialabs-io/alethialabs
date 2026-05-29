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
import { HelpTooltip } from "./help-tooltip";
import { Network } from "lucide-react";

interface VpcInfo {
	ID: string;
	CIDR: string;
	Name: string;
	IsDefault: boolean;
}

const CIDR_REGEX = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

function parseCidr(cidr: string) {
	if (!CIDR_REGEX.test(cidr)) return null;

	const [ip, prefixStr] = cidr.split("/");
	const prefix = parseInt(prefixStr);
	if (prefix < 0 || prefix > 32) return null;

	const parts = ip.split(".").map(Number);
	if (parts.some((p) => p < 0 || p > 255)) return null;

	const totalAddresses = Math.pow(2, 32 - prefix);
	const usableHosts = Math.max(totalAddresses - 5, 0); // AWS reserves 5

	const ipNum =
		(parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
	const mask = ~((1 << (32 - prefix)) - 1) >>> 0;
	const networkStart = (ipNum & mask) >>> 0;
	const networkEnd = (networkStart + totalAddresses - 1) >>> 0;

	const toIp = (n: number) =>
		`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;

	let sizeLabel: string;
	if (totalAddresses >= 65536) sizeLabel = "Large";
	else if (totalAddresses >= 4096) sizeLabel = "Medium";
	else if (totalAddresses >= 256) sizeLabel = "Small";
	else sizeLabel = "Very small";

	return {
		totalAddresses,
		usableHosts,
		prefix,
		rangeStart: toIp(networkStart),
		rangeEnd: toIp(networkEnd),
		sizeLabel,
	};
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
	const canUseExisting = !!region && vpcsForRegion.length > 0;

	const cidrError =
		vpcCidr.length > 0 && !CIDR_REGEX.test(vpcCidr)
			? "Invalid CIDR format. Example: 10.0.0.0/16"
			: null;

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center gap-2">
					<Network className="h-4 w-4 text-muted-foreground" />
					<CardTitle className="text-base">VPC & Networking</CardTitle>
					<HelpTooltip topic="vpc" />
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
						onClick={() => canUseExisting && onProvisionVpcChange(false)}
						disabled={!canUseExisting}
						className={`flex-1 p-3 rounded-lg border text-left transition-all text-sm ${
							!provisionVpc
								? "border-foreground bg-muted/20 font-medium"
								: "border-border/50 text-muted-foreground hover:border-border"
						} disabled:opacity-50 disabled:cursor-not-allowed`}
					>
						Use Existing VPC
						{!region && (
							<span className="block text-[11px] text-muted-foreground/60 mt-0.5">
								Select a region first
							</span>
						)}
						{region && vpcsForRegion.length === 0 && (
							<span className="block text-[11px] text-muted-foreground/60 mt-0.5">
								No VPCs found in {region}
							</span>
						)}
					</button>
				</div>

				{provisionVpc ? (
					<div className="grid md:grid-cols-2 gap-4">
						<div className="space-y-1.5">
							<div className="flex items-center gap-1.5">
								<Label className="text-xs">VPC CIDR Block</Label>
								<HelpTooltip topic="cidr" />
							</div>
							<Input
								placeholder="10.0.0.0/16"
								value={vpcCidr}
								onChange={(e) => onVpcCidrChange(e.target.value)}
								className={`h-9 text-sm font-mono ${cidrError ? "border-destructive" : ""}`}
							/>
							{cidrError ? (
								<p className="text-[11px] text-destructive">{cidrError}</p>
							) : (
								(() => {
									const info = parseCidr(vpcCidr);
									if (!info) return null;
									return (
										<div className="text-[11px] text-muted-foreground space-y-0.5 p-2 bg-muted/20 rounded border border-border/30">
											<div className="flex justify-between">
												<span>Addresses</span>
												<span className="font-mono">{info.totalAddresses.toLocaleString()}</span>
											</div>
											<div className="flex justify-between">
												<span>Usable IPs (AWS reserves 5)</span>
												<span className="font-mono">{info.usableHosts.toLocaleString()}</span>
											</div>
											<div className="flex justify-between">
												<span>Range</span>
												<span className="font-mono">{info.rangeStart} — {info.rangeEnd}</span>
											</div>
											<div className="flex justify-between">
												<span>Size</span>
												<span className="font-medium">/{info.prefix} ({info.sizeLabel})</span>
											</div>
										</div>
									);
								})()
							)}
						</div>
						<div className="space-y-1.5">
							<div className="flex items-center gap-1.5">
								<Label className="text-xs">NAT Gateway</Label>
								<HelpTooltip topic="nat-gateway" />
							</div>
							<Select
								value={singleNatGateway ? "single" : "ha"}
								onValueChange={(v) => onSingleNatGatewayChange(v === "single")}
							>
								<SelectTrigger className="h-9 text-sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="single">Single (cost-effective)</SelectItem>
									<SelectItem value="ha">Per-AZ (high availability)</SelectItem>
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
										<div className="flex items-center gap-2">
											<span className="font-mono text-xs">{vpc.ID}</span>
											<span className="text-muted-foreground text-xs">{vpc.CIDR}</span>
											{vpc.Name && (
												<span className="text-muted-foreground text-xs">{vpc.Name}</span>
											)}
											{vpc.IsDefault && (
												<Badge variant="outline" className="text-[10px] ml-1">Default</Badge>
											)}
										</div>
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
