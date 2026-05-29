"use client";

import {
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CloudIdentitySelector } from "./cloud-identity-selector";
import type { CachedAwsResources } from "@/app/server/actions/aws/resources";
import { UseFormReturn } from "react-hook-form";
import type { ConfigFormValues } from "./configuration-form";
import { Network } from "lucide-react";

const STATIC_REGIONS = [
	"us-east-1", "us-east-2", "us-west-1", "us-west-2",
	"ca-central-1",
	"eu-central-1", "eu-west-1", "eu-west-2", "eu-west-3", "eu-north-1",
	"ap-south-1", "ap-northeast-1", "ap-northeast-2", "ap-southeast-1", "ap-southeast-2",
	"sa-east-1",
];

interface SectionAwsNetworkProps {
	form: UseFormReturn<ConfigFormValues>;
	awsResources: CachedAwsResources | null;
}

export function SectionAwsNetwork({
	form,
	awsResources,
}: SectionAwsNetworkProps) {
	const enableDns = form.watch("enable_dns") ?? false;
	const region = form.watch("aws_region");
	const createVpc = form.watch("create_vpc") ?? true;

	const hasCachedRegions = (awsResources?.regions?.length ?? 0) > 0;
	const regions = hasCachedRegions ? awsResources!.regions : STATIC_REGIONS;
	const regionVpcs = region ? (awsResources?.vpcs?.[region] ?? []) : [];
	const hostedZones = awsResources?.hosted_zones ?? [];

	return (
		<Card className="shadow-sm border border-border/40">
			<CardHeader className="bg-muted/5 border-b border-border/40 pb-4">
				<CardTitle className="text-base font-medium">
					AWS & Network
				</CardTitle>
				<CardDescription className="text-xs">
					Select your AWS account, region, and network configuration.
				</CardDescription>
			</CardHeader>
			<CardContent className="pt-6 space-y-5">
				{/* AWS Account */}
				<FormField
					control={form.control}
					name="cloud_identity_id"
					render={({ field }) => (
						<FormItem>
							<FormLabel className="text-xs">
								AWS Account *
							</FormLabel>
							<FormControl>
								<CloudIdentitySelector
									value={field.value ?? null}
									onChange={(id, accountId) => {
										field.onChange(id);
										form.setValue(
											"aws_account_id",
											accountId,
										);
									}}
								/>
							</FormControl>
							<FormMessage />
						</FormItem>
					)}
				/>

				<div className="grid gap-5 sm:grid-cols-2">
					{/* Region — from cached AWS data */}
					<FormField
						control={form.control}
						name="aws_region"
						render={({ field }) => (
							<FormItem>
								<FormLabel className="text-xs">
									AWS Region *
								</FormLabel>
									<Select
									value={field.value ?? undefined}
									onValueChange={field.onChange}
								>
									<FormControl>
										<SelectTrigger className="h-9 text-sm">
											<SelectValue placeholder="Select region" />
										</SelectTrigger>
									</FormControl>
									<SelectContent>
										{regions.sort().map((r) => (
											<SelectItem key={r} value={r}>
												{r}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<FormMessage />
							</FormItem>
						)}
					/>

					{/* VPC */}
					<div className="space-y-2">
						<div className="flex items-center gap-2">
							<FormLabel className="text-xs">VPC</FormLabel>
							<div className="flex gap-1">
								<button
									type="button"
									disabled={regionVpcs.length === 0}
									onClick={() =>
										form.setValue("create_vpc", false)
									}
									className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${!createVpc ? "bg-foreground text-background border-foreground" : "border-border text-muted-foreground hover:text-foreground"} disabled:opacity-40 disabled:cursor-not-allowed`}
								>
									Existing{regionVpcs.length > 0 ? ` (${regionVpcs.length})` : ""}
								</button>
								<button
									type="button"
									onClick={() =>
										form.setValue("create_vpc", true)
									}
									className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${createVpc ? "bg-foreground text-background border-foreground" : "border-border text-muted-foreground hover:text-foreground"}`}
								>
									New
								</button>
							</div>
						</div>

						{createVpc ? (
							<FormField
								control={form.control}
								name="vpc_cidr"
								render={({ field }) => (
									<FormItem>
										<FormControl>
											<Input
												placeholder="10.0.0.0/16"
												className="h-9 text-sm font-mono"
												value={field.value ?? ""}
												onChange={field.onChange}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
						) : regionVpcs.length > 0 ? (
							<Select
								value={
									form.watch("selected_vpc_id") ?? undefined
								}
								onValueChange={(id) => {
									const vpc = regionVpcs.find(
										(v) => v.id === id,
									);
									form.setValue("selected_vpc_id", id);
									if (vpc)
										form.setValue("vpc_cidr", vpc.cidr);
								}}
							>
								<SelectTrigger className="h-9 text-sm">
									<SelectValue placeholder="Select VPC" />
								</SelectTrigger>
								<SelectContent>
									{regionVpcs.map((vpc) => (
										<SelectItem key={vpc.id} value={vpc.id}>
											<div className="flex items-center gap-2">
												<Network className="h-3 w-3 text-muted-foreground" />
												<span className="font-mono text-xs">
													{vpc.cidr}
												</span>
												{vpc.name && (
													<span className="text-xs text-muted-foreground">
														{vpc.name}
													</span>
												)}
												{vpc.isDefault && (
													<Badge
														variant="secondary"
														className="text-[9px] py-0 px-1"
													>
														default
													</Badge>
												)}
											</div>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						) : (
							<div className="flex items-center gap-2 h-9 px-3 text-xs text-muted-foreground border rounded-md bg-muted/20">
								{region
									? "No VPCs found in this region"
									: "Select a region first"}
							</div>
						)}
					</div>
				</div>

				{/* DNS */}
				<div className="flex items-center justify-between p-3 rounded-md border border-border/40">
					<div>
						<p className="text-sm font-medium">
							DNS Configuration
						</p>
						<p className="text-xs text-muted-foreground">
							Route 53 hosted zone (read-only — Trellis does not
							create DNS records)
						</p>
					</div>
					<Switch
						checked={enableDns}
						onCheckedChange={(checked) =>
							form.setValue("enable_dns", checked)
						}
					/>
				</div>

				{enableDns && (
					<div className="grid gap-4 sm:grid-cols-2 pl-3 border-l-2 border-border/40">
						{hostedZones.length > 0 ? (
							<FormField
								control={form.control}
								name="dns_hosted_zone"
								render={({ field }) => (
									<FormItem className="sm:col-span-2">
										<FormLabel className="text-xs">
											Hosted Zone
										</FormLabel>
										<Select
											value={field.value ?? undefined}
											onValueChange={(zoneId) => {
												field.onChange(zoneId);
												const zone =
													hostedZones.find(
														(z) => z.id === zoneId,
													);
												if (zone) {
													form.setValue(
														"dns_domain_name",
														zone.name,
													);
												}
											}}
										>
											<FormControl>
												<SelectTrigger className="h-9 text-sm">
													<SelectValue placeholder="Select hosted zone" />
												</SelectTrigger>
											</FormControl>
											<SelectContent>
												{hostedZones
													.filter((z) => !z.isPrivate)
													.map((zone) => (
														<SelectItem
															key={zone.id}
															value={zone.id}
														>
															<div className="flex items-center gap-2">
																<span>
																	{zone.name}
																</span>
																<span className="text-xs text-muted-foreground font-mono">
																	{zone.id}
																</span>
															</div>
														</SelectItem>
													))}
											</SelectContent>
										</Select>
										<FormMessage />
									</FormItem>
								)}
							/>
						) : (
							<>
								<FormField
									control={form.control}
									name="dns_hosted_zone"
									render={({ field }) => (
										<FormItem>
											<FormLabel className="text-xs">
												Hosted Zone ID
											</FormLabel>
											<FormControl>
												<Input
													placeholder="Z1234567890"
													className="h-9 text-sm"
													{...field}
													value={field.value ?? ""}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="dns_domain_name"
									render={({ field }) => (
										<FormItem>
											<FormLabel className="text-xs">
												Domain Name
											</FormLabel>
											<FormControl>
												<Input
													placeholder="example.com"
													className="h-9 text-sm"
													{...field}
													value={field.value ?? ""}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
							</>
						)}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
