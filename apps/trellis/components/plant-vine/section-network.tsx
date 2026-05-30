"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormControl, FormField, FormItem } from "@/components/ui/form";
import { HelpTooltip } from "./help-tooltip";
import { useVineStore } from "./use-vine-store";
import { Network } from "lucide-react";
import { useFormContext } from "react-hook-form";
import type { VineFormData } from "@/lib/validations/vine-form.schema";

interface VpcInfo { ID: string; CIDR: string; Name: string; IsDefault: boolean; }

const CIDR_REGEX = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

function parseCidr(cidr: string) {
	if (!CIDR_REGEX.test(cidr)) return null;
	const [ip, prefixStr] = cidr.split("/");
	const prefix = parseInt(prefixStr);
	if (prefix < 0 || prefix > 32) return null;
	const parts = ip.split(".").map(Number);
	if (parts.some((p) => p < 0 || p > 255)) return null;
	const totalAddresses = Math.pow(2, 32 - prefix);
	const usableHosts = Math.max(totalAddresses - 5, 0);
	const ipNum = (parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
	const mask = ~((1 << (32 - prefix)) - 1) >>> 0;
	const networkStart = (ipNum & mask) >>> 0;
	const networkEnd = (networkStart + totalAddresses - 1) >>> 0;
	const toIp = (n: number) => `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
	let sizeLabel: string;
	if (totalAddresses >= 65536) sizeLabel = "Large";
	else if (totalAddresses >= 4096) sizeLabel = "Medium";
	else if (totalAddresses >= 256) sizeLabel = "Small";
	else sizeLabel = "Very small";
	return { totalAddresses, usableHosts, prefix, rangeStart: toIp(networkStart), rangeEnd: toIp(networkEnd), sizeLabel };
}

export function SectionNetwork() {
	const { control, watch } = useFormContext<VineFormData>();
	const { awsResources } = useVineStore();
	const region = watch("vine.region");
	const provisionVpc = watch("network.provision_network");
	const vpcCidr = watch("network.cidr_block") || "";

	const vpcsForRegion = (awsResources?.vpcs as Record<string, VpcInfo[]>)?.[region] || [];
	const canUseExisting = !!region && vpcsForRegion.length > 0;
	const cidrError = vpcCidr.length > 0 && !CIDR_REGEX.test(vpcCidr) ? "Invalid CIDR format." : null;

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center gap-2">
					<Network className="h-4 w-4 text-muted-foreground" />
					<CardTitle className="text-base">Network</CardTitle>
					<HelpTooltip topic="vpc" />
				</div>
				<CardDescription className="text-xs">Create a new VPC or use an existing one.</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<FormField control={control} name="network.provision_network" render={({ field }) => (
					<FormItem>
						<div className="flex gap-2">
							<button type="button" onClick={() => field.onChange(true)}
								className={`flex-1 p-3 rounded-lg border text-left text-sm ${field.value ? "border-foreground bg-muted/20 font-medium" : "border-border/50 text-muted-foreground hover:border-border"}`}>
								Create New VPC
							</button>
							<button type="button" onClick={() => canUseExisting && field.onChange(false)} disabled={!canUseExisting}
								className={`flex-1 p-3 rounded-lg border text-left text-sm ${!field.value ? "border-foreground bg-muted/20 font-medium" : "border-border/50 text-muted-foreground hover:border-border"} disabled:opacity-50 disabled:cursor-not-allowed`}>
								Use Existing VPC
								{!region && <span className="block text-[11px] text-muted-foreground/60 mt-0.5">Select a region first</span>}
								{region && vpcsForRegion.length === 0 && <span className="block text-[11px] text-muted-foreground/60 mt-0.5">No VPCs found in {region}</span>}
							</button>
						</div>
					</FormItem>
				)} />

				{provisionVpc ? (
					<div className="grid md:grid-cols-2 gap-4">
						<div className="space-y-1.5">
							<div className="flex items-center gap-1.5">
								<Label className="text-xs">VPC CIDR Block</Label>
								<HelpTooltip topic="cidr" />
							</div>
							<FormField control={control} name="network.cidr_block" render={({ field }) => (
								<FormItem>
									<FormControl>
										<Input placeholder="10.0.0.0/16" {...field} value={field.value || ""} className={`h-9 text-sm font-mono ${cidrError ? "border-destructive" : ""}`} />
									</FormControl>
									{cidrError ? (
										<p className="text-[11px] text-destructive">{cidrError}</p>
									) : (() => {
										const info = parseCidr(field.value || "");
										if (!info) return null;
										return (
											<div className="text-[11px] text-muted-foreground space-y-0.5 p-2 bg-muted/20 rounded border border-border/30">
												<div className="flex justify-between"><span>Addresses</span><span className="font-mono">{info.totalAddresses.toLocaleString()}</span></div>
												<div className="flex justify-between"><span>Usable IPs</span><span className="font-mono">{info.usableHosts.toLocaleString()}</span></div>
												<div className="flex justify-between"><span>Range</span><span className="font-mono">{info.rangeStart} — {info.rangeEnd}</span></div>
												<div className="flex justify-between"><span>Size</span><span className="font-medium">/{info.prefix} ({info.sizeLabel})</span></div>
											</div>
										);
									})()}
								</FormItem>
							)} />
						</div>
						<div className="space-y-1.5">
							<div className="flex items-center gap-1.5">
								<Label className="text-xs">NAT Gateway</Label>
								<HelpTooltip topic="nat-gateway" />
							</div>
							<FormField control={control} name="network.single_nat_gateway" render={({ field }) => (
								<FormItem>
									<Select value={field.value ? "single" : "ha"} onValueChange={(v) => field.onChange(v === "single")}>
										<FormControl>
											<SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
										</FormControl>
										<SelectContent>
											<SelectItem value="single">Single (cost-effective)</SelectItem>
											<SelectItem value="ha">Per-AZ (high availability)</SelectItem>
										</SelectContent>
									</Select>
								</FormItem>
							)} />
						</div>
					</div>
				) : (
					<FormField control={control} name="network.network_id" render={({ field }) => (
						<FormItem className="space-y-1.5">
							<Label className="text-xs">Select VPC</Label>
							<Select value={field.value || ""} onValueChange={field.onChange}>
								<FormControl>
									<SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Choose a VPC" /></SelectTrigger>
								</FormControl>
								<SelectContent>
									{vpcsForRegion.map((vpc: VpcInfo) => (
										<SelectItem key={vpc.ID} value={vpc.ID}>
											<div className="flex items-center gap-2">
												<span className="font-mono text-xs">{vpc.ID}</span>
												<span className="text-muted-foreground text-xs">{vpc.CIDR}</span>
												{vpc.Name && <span className="text-muted-foreground text-xs">{vpc.Name}</span>}
												{vpc.IsDefault && <Badge variant="outline" className="text-[10px] ml-1">Default</Badge>}
											</div>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</FormItem>
					)} />
				)}
			</CardContent>
		</Card>
	);
}
