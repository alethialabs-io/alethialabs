"use client";

import {
	getCachedAwsResources,
	type CachedAwsResources,
} from "@/app/server/actions/aws/resources";
import {
	refreshAwsResources,
	persistCachedResources,
} from "@/app/(private)/dashboard/providers/actions";
import { getJobStatus } from "@/app/server/actions/jobs";
import { CloudIdentitySelector } from "@/components/configuration/cloud-identity-selector";
import { Button } from "@/components/ui/button";
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
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Cloud, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

const STATIC_REGIONS = [
	{ group: "Europe", regions: [
		{ value: "eu-west-1", label: "Ireland" },
		{ value: "eu-central-1", label: "Frankfurt" },
		{ value: "eu-west-2", label: "London" },
		{ value: "eu-north-1", label: "Stockholm" },
	]},
	{ group: "US East", regions: [
		{ value: "us-east-1", label: "N. Virginia" },
		{ value: "us-east-2", label: "Ohio" },
	]},
	{ group: "US West", regions: [
		{ value: "us-west-1", label: "N. California" },
		{ value: "us-west-2", label: "Oregon" },
	]},
];

interface Props {
	awsConnected: boolean;
	cloudIdentityId: string | null;
	onCloudIdentityChange: (id: string | null, accountId?: string) => void;
	region: string;
	onRegionChange: (v: string) => void;
	awsResources: CachedAwsResources | null;
	onAwsResourcesChange?: (resources: CachedAwsResources | null) => void;
}

export function SectionAwsRegion({
	awsConnected,
	cloudIdentityId,
	onCloudIdentityChange,
	region,
	onRegionChange,
	awsResources,
	onAwsResourcesChange,
}: Props) {
	const [isRefreshing, setIsRefreshing] = useState(false);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const cachedRegions = awsResources?.regions as string[] | undefined;
	const cachedAt = awsResources?.cached_at;

	const stopPolling = useCallback(() => {
		if (pollRef.current) {
			clearInterval(pollRef.current);
			pollRef.current = null;
		}
	}, []);

	useEffect(() => () => stopPolling(), [stopPolling]);

	const handleRefresh = async () => {
		if (!cloudIdentityId) return;
		setIsRefreshing(true);

		try {
			const { jobId } = await refreshAwsResources(cloudIdentityId);

			pollRef.current = setInterval(async () => {
				try {
					const result = await getJobStatus(jobId);
					if (!result) return;

					if (result.status === "SUCCESS") {
						stopPolling();
						await persistCachedResources(cloudIdentityId, jobId);
						const fresh = await getCachedAwsResources(cloudIdentityId);
						onAwsResourcesChange?.(fresh);
						setIsRefreshing(false);
						toast.success("AWS resources refreshed");
					} else if (result.status === "FAILED") {
						stopPolling();
						setIsRefreshing(false);
						toast.error(result.error_message || "Failed to fetch AWS resources");
					}
				} catch {
					stopPolling();
					setIsRefreshing(false);
				}
			}, 2000);
		} catch (err: any) {
			setIsRefreshing(false);
			toast.error(err.message || "Failed to refresh");
		}
	};

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<Cloud className="h-4 w-4 text-muted-foreground" />
						<CardTitle className="text-base">AWS Account & Region</CardTitle>
					</div>
					{cloudIdentityId && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="h-8 text-xs"
							onClick={handleRefresh}
							disabled={isRefreshing}
						>
							{isRefreshing ? (
								<Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
							) : (
								<RefreshCw className="h-3.5 w-3.5 mr-1.5" />
							)}
							{isRefreshing ? "Fetching..." : "Refresh"}
						</Button>
					)}
				</div>
				<CardDescription className="text-xs">
					Select the AWS account and region for this infrastructure.
					{cachedAt && (
						<span className="text-muted-foreground/60 ml-1">
							Last refreshed: {new Date(cachedAt).toLocaleTimeString()}
						</span>
					)}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="space-y-1.5">
					<Label className="text-xs">
						AWS Account <span className="text-destructive">*</span>
					</Label>
					<CloudIdentitySelector
						value={cloudIdentityId}
						onChange={(id, accountId) => onCloudIdentityChange(id, accountId)}
					/>
				</div>

				<div className="space-y-1.5">
					<Label className="text-xs">
						Region <span className="text-destructive">*</span>
					</Label>
					<Select value={region} onValueChange={onRegionChange}>
						<SelectTrigger className="h-9 text-sm">
							<SelectValue placeholder="Select a region" />
						</SelectTrigger>
						<SelectContent>
							{cachedRegions && cachedRegions.length > 0 ? (
								cachedRegions.map((r) => (
									<SelectItem key={r} value={r}>
										{r}
									</SelectItem>
								))
							) : (
								STATIC_REGIONS.map((group) => (
									<SelectGroup key={group.group}>
										<SelectLabel>{group.group}</SelectLabel>
										{group.regions.map((r) => (
											<SelectItem key={r.value} value={r.value}>
												{r.label} ({r.value})
											</SelectItem>
										))}
									</SelectGroup>
								))
							)}
						</SelectContent>
					</Select>
					{!cachedRegions && cloudIdentityId && (
						<p className="text-[10px] text-muted-foreground">
							Showing default regions. Click "Refresh" to load your account's enabled regions.
						</p>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
