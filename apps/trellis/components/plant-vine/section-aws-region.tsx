"use client";

import type { CachedAwsResources } from "@/app/server/actions/aws/resources";
import { CloudIdentitySelector } from "@/components/configuration/cloud-identity-selector";
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
import { Cloud } from "lucide-react";

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
	{ group: "Asia Pacific", regions: [
		{ value: "ap-southeast-1", label: "Singapore" },
		{ value: "ap-northeast-1", label: "Tokyo" },
	]},
];

interface Props {
	awsConnected: boolean;
	cloudIdentityId: string | null;
	onCloudIdentityChange: (id: string | null) => void;
	region: string;
	onRegionChange: (v: string) => void;
	awsResources: CachedAwsResources | null;
}

export function SectionAwsRegion({
	awsConnected,
	cloudIdentityId,
	onCloudIdentityChange,
	region,
	onRegionChange,
	awsResources,
}: Props) {
	const cachedRegions = awsResources?.regions as string[] | undefined;

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center gap-2">
					<Cloud className="h-4 w-4 text-muted-foreground" />
					<CardTitle className="text-base">AWS Account & Region</CardTitle>
				</div>
				<CardDescription className="text-xs">
					Select the AWS account and region for this infrastructure.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="space-y-1.5">
					<Label className="text-xs">
						AWS Account <span className="text-destructive">*</span>
					</Label>
					<CloudIdentitySelector
						value={cloudIdentityId}
						onChange={(id) => onCloudIdentityChange(id)}
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
				</div>
			</CardContent>
		</Card>
	);
}
