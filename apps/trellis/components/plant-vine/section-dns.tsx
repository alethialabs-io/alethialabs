"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { FormControl, FormField, FormItem } from "@/components/ui/form";
import { HelpTooltip } from "./help-tooltip";
import { useVineStore } from "./use-vine-store";
import { Globe, Shield } from "lucide-react";
import { useFormContext } from "react-hook-form";
import type { VineFormData } from "@/lib/validations/vine-form.schema";

interface HostedZone { ID: string; Name: string; IsPrivate: boolean; }

export function SectionDns() {
	const { control, watch, setValue } = useFormContext<VineFormData>();
	const { awsResources } = useVineStore();
	const enabled = watch("dns.enabled");

	const hostedZones = ((awsResources?.hosted_zones as HostedZone[]) || []).filter((z) => !z.IsPrivate);

	const handleZoneChange = (zoneId: string) => {
		setValue("dns.zone_id", zoneId);
		const zone = hostedZones.find((z) => z.ID === zoneId);
		if (zone) setValue("dns.domain_name", zone.Name.replace(/\.$/, ""));
	};

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<Globe className="h-4 w-4 text-muted-foreground" />
						<CardTitle className="text-base">DNS & Security</CardTitle>
					</div>
					<FormField control={control} name="dns.enabled" render={({ field }) => (
						<Switch checked={field.value ?? false} onCheckedChange={field.onChange} />
					)} />
				</div>
				<CardDescription className="text-xs">Configure Route53 DNS, TLS certificates, and WAF.</CardDescription>
			</CardHeader>
			{enabled && (
				<CardContent className="space-y-4">
					<div className="grid md:grid-cols-2 gap-4">
						<div className="space-y-1.5">
							<div className="flex items-center gap-1.5">
								<Label className="text-xs">Hosted Zone</Label>
								<HelpTooltip topic="hosted-zone" />
							</div>
							{hostedZones.length > 0 ? (
								<FormField control={control} name="dns.zone_id" render={({ field }) => (
									<FormItem>
										<Select value={field.value || ""} onValueChange={handleZoneChange}>
											<FormControl><SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Select a hosted zone" /></SelectTrigger></FormControl>
											<SelectContent>
												{hostedZones.map((zone) => (
													<SelectItem key={zone.ID} value={zone.ID}>
														{zone.Name.replace(/\.$/, "")}
														<span className="text-muted-foreground ml-2 text-[11px]">{zone.ID}</span>
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</FormItem>
								)} />
							) : (
								<FormField control={control} name="dns.zone_id" render={({ field }) => (
									<FormItem>
										<FormControl><Input placeholder="Z1234567890ABC" {...field} value={field.value || ""} className="h-9 text-sm font-mono" /></FormControl>
									</FormItem>
								)} />
							)}
						</div>
						<div className="space-y-1.5">
							<Label className="text-xs">Domain Name</Label>
							<FormField control={control} name="dns.domain_name" render={({ field }) => (
								<FormItem>
									<FormControl><Input placeholder="example.com" {...field} value={field.value || ""} className="h-9 text-sm" /></FormControl>
								</FormItem>
							)} />
						</div>
					</div>
					<div className="space-y-2">
						<FormField control={control} name="dns.provider_config.acm_certificate" render={({ field }) => (
							<div className="flex items-center justify-between p-3 border border-border/50 rounded-lg">
								<div className="flex items-center gap-1.5">
									<div><p className="text-sm font-medium">ACM Certificate</p><p className="text-[11px] text-muted-foreground">Free with AWS services</p></div>
									<HelpTooltip topic="acm-certificate" />
								</div>
								<Switch checked={field.value ?? false} onCheckedChange={field.onChange} />
							</div>
						)} />
						<FormField control={control} name="dns.provider_config.cloudfront_waf" render={({ field }) => (
							<div className="flex items-center justify-between p-3 border border-border/50 rounded-lg">
								<div className="flex items-center gap-1.5">
									<Shield className="h-3.5 w-3.5 text-muted-foreground" />
									<div><p className="text-sm font-medium">CloudFront WAF</p><p className="text-[11px] text-muted-foreground">~$5/mo</p></div>
									<HelpTooltip topic="cloudfront-waf" />
								</div>
								<Switch checked={field.value ?? false} onCheckedChange={field.onChange} />
							</div>
						)} />
						<FormField control={control} name="dns.provider_config.application_waf" render={({ field }) => (
							<div className="flex items-center justify-between p-3 border border-border/50 rounded-lg">
								<div className="flex items-center gap-1.5">
									<Shield className="h-3.5 w-3.5 text-muted-foreground" />
									<div><p className="text-sm font-medium">Application WAF</p><p className="text-[11px] text-muted-foreground">~$5/mo</p></div>
									<HelpTooltip topic="application-waf" />
								</div>
								<Switch checked={field.value ?? false} onCheckedChange={field.onChange} />
							</div>
						)} />
					</div>
				</CardContent>
			)}
		</Card>
	);
}
