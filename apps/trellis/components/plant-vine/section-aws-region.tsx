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

const REGION_LABELS: Record<string, string> = {
	"us-east-1": "N. Virginia",
	"us-east-2": "Ohio",
	"us-west-1": "N. California",
	"us-west-2": "Oregon",
	"ca-central-1": "Central",
	"eu-central-1": "Frankfurt",
	"eu-west-1": "Ireland",
	"eu-west-2": "London",
	"eu-west-3": "Paris",
	"eu-north-1": "Stockholm",
	"eu-south-1": "Milan",
	"ap-south-1": "Mumbai",
	"ap-northeast-1": "Tokyo",
	"ap-northeast-2": "Seoul",
	"ap-northeast-3": "Osaka",
	"ap-southeast-1": "Singapore",
	"ap-southeast-2": "Sydney",
	"sa-east-1": "São Paulo",
	"af-south-1": "Cape Town",
	"me-south-1": "Bahrain",
	"me-central-1": "UAE",
	"ap-east-1": "Hong Kong",
	"ap-south-2": "Hyderabad",
	"ap-southeast-3": "Jakarta",
	"eu-south-2": "Spain",
	"eu-central-2": "Zurich",
	"il-central-1": "Tel Aviv",
	"ca-west-1": "Calgary",
};

const REGION_GROUPS: Record<string, string> = {
	"us-east": "United States",
	"us-west": "United States",
	"ca-": "Canada",
	"eu-": "Europe",
	"ap-": "Asia Pacific",
	"sa-": "South America",
	"af-": "Africa",
	"me-": "Middle East",
	"il-": "Israel",
};

function getRegionGroup(code: string): string {
	for (const [prefix, group] of Object.entries(REGION_GROUPS)) {
		if (code.startsWith(prefix)) return group;
	}
	return "Other";
}

function groupRegions(codes: string[]): Array<{ group: string; regions: Array<{ value: string; label: string }> }> {
	const grouped = new Map<string, Array<{ value: string; label: string }>>();
	for (const code of codes) {
		const group = getRegionGroup(code);
		const label = REGION_LABELS[code] || code;
		if (!grouped.has(group)) grouped.set(group, []);
		grouped.get(group)!.push({ value: code, label });
	}
	return Array.from(grouped.entries()).map(([group, regions]) => ({
		group,
		regions: regions.sort((a, b) => a.label.localeCompare(b.label)),
	}));
}

const DEFAULT_REGIONS = [
	"us-east-1", "us-east-2", "us-west-1", "us-west-2",
	"eu-west-1", "eu-central-1", "eu-west-2", "eu-north-1",
	"ap-southeast-1", "ap-northeast-1",
];

interface Props {
	awsConnected: boolean;
	cloudIdentityId: string | null;
	onCloudIdentityChange: (id: string | null, accountId?: string) => void;
	region: string;
	onRegionChange: (v: string) => void;
	awsResources: CachedAwsResources | null;
	onAwsResourcesChange?: (resources: CachedAwsResources | null) => void;
	submitted?: boolean;
}

export function SectionAwsRegion({
	awsConnected,
	cloudIdentityId,
	onCloudIdentityChange,
	region,
	onRegionChange,
	awsResources,
	onAwsResourcesChange,
	submitted,
}: Props) {
	const [isRefreshing, setIsRefreshing] = useState(false);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const cachedRegionCodes = awsResources?.regions as string[] | undefined;
	const cachedAt = awsResources?.cached_at;
	const regionGroups = groupRegions(
		cachedRegionCodes && cachedRegionCodes.length > 0 ? cachedRegionCodes : DEFAULT_REGIONS,
	);

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
					{submitted && !cloudIdentityId && (
						<p className="text-[11px] text-destructive">AWS account is required.</p>
					)}
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
							{regionGroups.map((group) => (
								<SelectGroup key={group.group}>
									<SelectLabel>{group.group}</SelectLabel>
									{group.regions.map((r) => (
										<SelectItem key={r.value} value={r.value}>
											{r.label} ({r.value})
										</SelectItem>
									))}
								</SelectGroup>
							))}
						</SelectContent>
					</Select>
					{submitted && !region && (
						<p className="text-[11px] text-destructive">Region is required.</p>
					)}
					{!cachedRegionCodes && cloudIdentityId && !submitted && (
						<p className="text-xs text-muted-foreground">
							Showing default regions. Click "Refresh" to load your account's enabled regions.
						</p>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
