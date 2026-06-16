"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { CloudIdentitySelector } from "./cloud-identity-selector";
import {
	refreshCloudResources,
	completeResourceRefresh,
} from "@/app/server/actions/cloud-resources";
import { getJobStatus } from "@/app/server/actions/jobs";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import { Button } from "@/components/ui/button";
import {
	Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { useCloudProvider, useProviderSlug, useProviderMeta, REGION_LABELS, groupRegions } from "@/lib/cloud-providers";
import type { AnyCachedResources, CloudProviderSlug } from "@/lib/cloud-providers";
import { Loader2, RefreshCw } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useCallback, useEffect, useRef, useState } from "react";
import { useFormContext } from "react-hook-form";
import { toast } from "sonner";
import type { VineFormData } from "@/lib/validations/vine-form.schema";

interface ProviderRibbonProps {
	identities: CloudIdentityOption[];
}

/** Compact provider + region bar that sits above the form tabs. */
export function ProviderRibbon({ identities }: ProviderRibbonProps) {
	const { control } = useFormContext<VineFormData>();
	const provider = useProviderSlug();
	const providerMeta = useProviderMeta();
	const { identityId, cachedAt, isStale, updateResources } = useCloudProvider();
	const [isRefreshing, setIsRefreshing] = useState(false);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const allRegionCodes = Object.keys(REGION_LABELS[provider] ?? {});
	const regionGroups = groupRegions(allRegionCodes, provider);

	const stopPolling = useCallback(() => {
		if (pollRef.current) {
			clearInterval(pollRef.current);
			pollRef.current = null;
		}
	}, []);

	useEffect(() => () => stopPolling(), [stopPolling]);

	const handleRefresh = async () => {
		if (!identityId) {
			toast.error("Select a cloud account first.");
			return;
		}
		setIsRefreshing(true);
		toast.info(`Refreshing ${providerMeta.shortName} resources...`);
		try {
			const { jobId } = await refreshCloudResources(identityId);
			pollRef.current = setInterval(async () => {
				try {
					const result = await getJobStatus(jobId);
					if (!result) return;
					if (result.status === "SUCCESS") {
						stopPolling();
						const { resources, cachedAt: newCachedAt } =
							await completeResourceRefresh(identityId, jobId);
						updateResources(
							resources as AnyCachedResources | null,
							newCachedAt ?? new Date().toISOString(),
						);
						toast.success("Resources refreshed!");
						setIsRefreshing(false);
					} else if (result.status === "FAILED") {
						stopPolling();
						toast.error(result.error_message || "Resource fetch failed.");
						setIsRefreshing(false);
					}
				} catch {
					stopPolling();
					toast.error("Failed to check refresh status.");
					setIsRefreshing(false);
				}
			}, 2000);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to start refresh.");
			setIsRefreshing(false);
		}
	};

	const cachedLabel = cachedAt
		? formatDistanceToNow(new Date(cachedAt), { addSuffix: true })
		: null;

	return (
		<div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 p-4 rounded-lg border border-border/50 bg-muted/5">
			{/* Cloud Account */}
			<div className="flex-1 min-w-0 w-full sm:w-auto">
				<FormField control={control} name="vine.cloud_identity_id" render={({ field }) => (
					<FormItem>
						<FormControl>
							<CloudIdentitySelector
								identities={identities}
								value={field.value}
								onChange={(id, _provider) => field.onChange(id)}
							/>
						</FormControl>
						<FormMessage className="text-[11px]" />
					</FormItem>
				)} />
			</div>

			{/* Region */}
			<div className="w-full sm:w-56">
				<FormField control={control} name="vine.region" render={({ field }) => (
					<FormItem>
						<Select value={field.value || ""} onValueChange={field.onChange}>
							<FormControl>
								<SelectTrigger className="h-9 text-sm">
									<SelectValue placeholder="Region" />
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
					<FormMessage className="text-[11px]" />
					</FormItem>
				)} />
			</div>

			{/* Cache status + Refresh */}
			<div className="flex items-center gap-2 shrink-0">
				{cachedLabel && (
					<span className={`text-[11px] whitespace-nowrap ${isStale ? "text-muted-foreground" : "text-muted-foreground"}`}>
						{isStale && "Stale — "}{cachedLabel}
					</span>
				)}
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="h-8 text-xs"
					onClick={handleRefresh}
					disabled={isRefreshing || !identityId}
				>
					{isRefreshing
						? <Loader2 className="h-3.5 w-3.5 animate-spin" />
						: <RefreshCw className="h-3.5 w-3.5" />
					}
				</Button>
			</div>
		</div>
	);
}
