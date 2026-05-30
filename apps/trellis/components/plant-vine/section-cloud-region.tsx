"use client";

import { CloudIdentitySelector } from "./cloud-identity-selector";
import { Button } from "@/components/ui/button";
import {
	Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
	Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { FormControl, FormField, FormItem } from "@/components/ui/form";
import { useProviderSlug, useProviderMeta } from "@/lib/cloud-providers";
import { REGION_LABELS } from "@/lib/cloud-providers";
import { Cloud, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useFormContext } from "react-hook-form";
import { toast } from "sonner";
import type { VineFormData } from "@/lib/validations/vine-form.schema";

/** Groups region codes into geographic sections using the registry labels. */
function groupRegions(codes: string[], provider: import("@/lib/cloud-providers").CloudProviderSlug) {
	const labels = REGION_LABELS[provider] ?? {};
	const grouped = new Map<string, Array<{ value: string; label: string }>>();
	for (const code of codes) {
		const meta = labels[code];
		const group = meta?.group ?? "Other";
		const label = meta?.label ?? code;
		if (!grouped.has(group)) grouped.set(group, []);
		grouped.get(group)!.push({ value: code, label });
	}
	return Array.from(grouped.entries()).map(([group, regions]) => ({
		group, regions: regions.sort((a, b) => a.label.localeCompare(b.label)),
	}));
}

interface SectionCloudRegionProps {
	identities: import("@/app/server/actions/aws/identities").CloudIdentityOption[];
}

export function SectionCloudRegion({ identities }: SectionCloudRegionProps) {
	const { control } = useFormContext<VineFormData>();
	const provider = useProviderSlug();
	const providerMeta = useProviderMeta();
	const [isRefreshing, setIsRefreshing] = useState(false);

	const allRegionCodes = Object.keys(REGION_LABELS[provider] ?? {});
	const regionGroups = groupRegions(allRegionCodes, provider);

	const handleRefresh = async () => {
		setIsRefreshing(true);
		toast.info(`Refreshing ${providerMeta.shortName} resources...`);
		setTimeout(() => setIsRefreshing(false), 2000);
	};

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<Cloud className="h-4 w-4 text-muted-foreground" />
						<CardTitle className="text-base">Cloud Account & Region</CardTitle>
					</div>
					<Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={handleRefresh} disabled={isRefreshing}>
						{isRefreshing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
						{isRefreshing ? "Fetching..." : "Refresh"}
					</Button>
				</div>
				<CardDescription className="text-xs">
					Select the cloud account and region for this vine.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="space-y-1.5">
					<Label className="text-xs">Cloud Account <span className="text-destructive">*</span></Label>
					<FormField control={control} name="vine.cloud_identity_id" render={({ field }) => (
						<FormItem>
							<FormControl>
								<CloudIdentitySelector
									identities={identities}
									value={field.value}
									onChange={(id, provider) => {
										field.onChange(id);
									}}
								/>
							</FormControl>
						</FormItem>
					)} />
				</div>

				<div className="space-y-1.5">
					<Label className="text-xs">Region <span className="text-destructive">*</span></Label>
					<FormField control={control} name="vine.region" render={({ field }) => (
						<FormItem>
							<Select value={field.value || ""} onValueChange={field.onChange}>
								<FormControl>
									<SelectTrigger className="h-9 text-sm">
										<SelectValue placeholder="Select a region" />
									</SelectTrigger>
								</FormControl>
								<SelectContent>
									{regionGroups.map((group) => (
										<SelectGroup key={group.group}>
											<SelectLabel>{group.group}</SelectLabel>
											{group.regions.map((r) => (
												<SelectItem key={r.value} value={r.value}>{r.label} ({r.value})</SelectItem>
											))}
										</SelectGroup>
									))}
								</SelectContent>
							</Select>
						</FormItem>
					)} />
					{allRegionCodes.length === 0 && (
						<p className="text-xs text-muted-foreground">Click &quot;Refresh&quot; to load your account&apos;s regions.</p>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
