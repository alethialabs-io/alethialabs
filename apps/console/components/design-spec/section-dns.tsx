"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { FormControl, FormField, FormItem } from "@/components/ui/form";
import { HelpTooltip } from "./help-tooltip";
import { useCloudProvider, useProviderMeta, useProviderSlug, WAF_OPTIONS, CERT_OPTIONS } from "@/lib/cloud-providers";
import { getConnectorProvider } from "@/lib/connectors/registry.generated";
import { useConnectedProviders } from "./connectors-context";
import type {
	CachedResources,
	GcpCachedResources,
	AzureCachedResources,
} from "@/types/database-custom.types";
import { Globe, Shield } from "lucide-react";
import { useFormContext } from "react-hook-form";
import type { SpecFormData } from "@/lib/validations/spec-form.schema";

interface DnsZoneOption { id: string; name: string; }

/** Extracts DNS zones from cached resources based on provider. */
function getDnsZones(
	cached: CachedResources | GcpCachedResources | AzureCachedResources | null,
	provider: string,
): DnsZoneOption[] {
	if (!cached) return [];

	if (provider === "aws") {
		const res = cached as CachedResources;
		return (res.hosted_zones ?? [])
			.filter((z) => !z.IsPrivate)
			.map((z) => ({ id: z.ID, name: z.Name.replace(/\.$/, "") }));
	}

	if (provider === "gcp") {
		const res = cached as GcpCachedResources;
		return (res.managed_zones ?? [])
			.filter((z) => z.visibility === "public")
			.map((z) => ({ id: z.name, name: z.dnsName.replace(/\.$/, "") }));
	}

	if (provider === "azure") {
		const res = cached as AzureCachedResources;
		return (res.dns_zones ?? []).map((z) => ({ id: z.id, name: z.name }));
	}

	return [];
}

export function SectionDns() {
	const { control, watch, setValue } = useFormContext<SpecFormData>();
	const { cachedResources } = useCloudProvider();
	const provider = useProviderSlug();
	const meta = useProviderMeta();
	const enabled = watch("dns.enabled");

	const dnsZones = getDnsZones(cachedResources, provider);
	const wafOptions = WAF_OPTIONS[provider];
	const certOption = CERT_OPTIONS[provider];

	// Pluggable DNS providers (Cloudflare, …) the user has CONNECTED, offered
	// alongside the cloud-native default. Empty / "native" = the cluster cloud's
	// own DNS. Unconnected providers are dropped so you can't pick one that would
	// fail at provision time.
	const dnsProviders = useConnectedProviders("dns");
	const selectedDnsProvider = watch("dns.provider") || "native";
	const pluggable = getConnectorProvider("dns", selectedDnsProvider);

	const handleZoneChange = (zoneId: string) => {
		setValue("dns.zone_id", zoneId);
		const zone = dnsZones.find((z) => z.id === zoneId);
		if (zone) setValue("dns.domain_name", zone.name);
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
				<CardDescription className="text-xs">Configure {meta.dnsService} DNS, TLS certificates, and WAF.</CardDescription>
			</CardHeader>
			{enabled && (
				<CardContent className="space-y-4">
					{dnsProviders.length > 0 && (
						<div className="space-y-1.5">
							<div className="flex items-center gap-1.5">
								<Label className="text-xs">DNS Provider</Label>
								<HelpTooltip topic="hosted-zone" />
							</div>
							<FormField control={control} name="dns.provider" render={({ field }) => (
								<FormItem>
									<Select value={field.value || "native"} onValueChange={field.onChange}>
										<FormControl><SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger></FormControl>
										<SelectContent>
											<SelectItem value="native">Cloud-native ({meta.dnsService})</SelectItem>
											{dnsProviders.map((p) => (
												<SelectItem key={p.slug} value={p.slug}>{p.name}</SelectItem>
											))}
										</SelectContent>
									</Select>
								</FormItem>
							)} />
							{pluggable && (
								<p className="text-[11px] text-muted-foreground">
									Requires a connected {pluggable.name} credential in Connectors.
								</p>
							)}
						</div>
					)}
					<div className="grid md:grid-cols-2 gap-4">
						<div className="space-y-1.5">
							<div className="flex items-center gap-1.5">
								<Label className="text-xs">DNS Zone</Label>
								<HelpTooltip topic="hosted-zone" />
							</div>
							{dnsZones.length > 0 ? (
								<FormField control={control} name="dns.zone_id" render={({ field }) => (
									<FormItem>
										<Select value={field.value || ""} onValueChange={handleZoneChange}>
											<FormControl><SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Select a DNS zone" /></SelectTrigger></FormControl>
											<SelectContent>
												{dnsZones.map((zone) => (
													<SelectItem key={zone.id} value={zone.id}>
														{zone.name}
														<span className="text-muted-foreground ml-2 text-[11px]">{zone.id}</span>
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</FormItem>
								)} />
							) : (
								<FormField control={control} name="dns.zone_id" render={({ field }) => (
									<FormItem>
										<FormControl><Input placeholder="Zone ID" {...field} value={field.value || ""} className="h-9 text-sm font-mono" /></FormControl>
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
						{/* Managed Certificate */}
						<FormField control={control} name={`dns.provider_config.${certOption.providerConfigKey}`} render={({ field }) => (
							<div className="flex items-center justify-between p-3 border border-border/50 rounded-lg">
								<div>
									<p className="text-sm font-medium">{certOption.label}</p>
									<p className="text-[11px] text-muted-foreground">{certOption.description}</p>
								</div>
								<Switch checked={!!field.value} onCheckedChange={field.onChange} />
							</div>
						)} />

						{/* WAF options (provider-specific) */}
						{wafOptions.map((waf) => (
							<FormField key={waf.providerConfigKey} control={control} name={`dns.provider_config.${waf.providerConfigKey}`} render={({ field }) => (
								<div className="flex items-center justify-between p-3 border border-border/50 rounded-lg">
									<div className="flex items-center gap-1.5">
										<Shield className="h-3.5 w-3.5 text-muted-foreground" />
										<div>
											<p className="text-sm font-medium">{waf.label}</p>
											<p className="text-[11px] text-muted-foreground">{waf.description} {waf.cost}</p>
										</div>
									</div>
									<Switch checked={!!field.value} onCheckedChange={field.onChange} />
								</div>
							)} />
						))}
					</div>
				</CardContent>
			)}
		</Card>
	);
}
