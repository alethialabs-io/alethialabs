"use client";

import type { CachedAwsResources } from "@/app/server/actions/aws/resources";
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
import { Switch } from "@/components/ui/switch";
import { HelpTooltip } from "./help-tooltip";
import { Globe, Shield } from "lucide-react";

interface HostedZone {
	ID: string;
	Name: string;
	IsPrivate: boolean;
}

interface Props {
	enabled: boolean;
	onEnabledChange: (v: boolean) => void;
	hostedZoneId: string | null;
	onHostedZoneIdChange: (v: string | null) => void;
	domainName: string | null;
	onDomainNameChange: (v: string | null) => void;
	acmCertificate: boolean;
	onAcmCertificateChange: (v: boolean) => void;
	cloudfrontWaf: boolean;
	onCloudfrontWafChange: (v: boolean) => void;
	applicationWaf: boolean;
	onApplicationWafChange: (v: boolean) => void;
	awsResources: CachedAwsResources | null;
}

export function SectionDns({
	enabled,
	onEnabledChange,
	hostedZoneId,
	onHostedZoneIdChange,
	domainName,
	onDomainNameChange,
	acmCertificate,
	onAcmCertificateChange,
	cloudfrontWaf,
	onCloudfrontWafChange,
	applicationWaf,
	onApplicationWafChange,
	awsResources,
}: Props) {
	const hostedZones = ((awsResources?.hosted_zones as HostedZone[]) || []).filter(
		(z) => !z.IsPrivate,
	);

	const handleZoneChange = (zoneId: string) => {
		onHostedZoneIdChange(zoneId);
		const zone = hostedZones.find((z) => z.ID === zoneId);
		if (zone) {
			onDomainNameChange(zone.Name.replace(/\.$/, ""));
		}
	};

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<Globe className="h-4 w-4 text-muted-foreground" />
						<CardTitle className="text-base">DNS & Security</CardTitle>
					</div>
					<Switch checked={enabled} onCheckedChange={onEnabledChange} />
				</div>
				<CardDescription className="text-xs">
					Configure Route53 DNS, TLS certificates, and web application firewall.
				</CardDescription>
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
								<Select
									value={hostedZoneId || ""}
									onValueChange={handleZoneChange}
								>
									<SelectTrigger className="h-9 text-sm">
										<SelectValue placeholder="Select a hosted zone" />
									</SelectTrigger>
									<SelectContent>
										{hostedZones.map((zone) => (
											<SelectItem key={zone.ID} value={zone.ID}>
												{zone.Name.replace(/\.$/, "")}
												<span className="text-muted-foreground ml-2 text-[11px]">
													{zone.ID}
												</span>
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							) : (
								<Input
									placeholder="Z1234567890ABC"
									value={hostedZoneId || ""}
									onChange={(e) => onHostedZoneIdChange(e.target.value || null)}
									className="h-9 text-sm font-mono"
								/>
							)}
							{!hostedZones.length && (
								<p className="text-xs text-muted-foreground">
									Click "Refresh" in the AWS section to load your hosted zones.
								</p>
							)}
						</div>
						<div className="space-y-1.5">
							<Label className="text-xs">Domain Name</Label>
							<Input
								placeholder="example.com"
								value={domainName || ""}
								onChange={(e) => onDomainNameChange(e.target.value || null)}
								className="h-9 text-sm"
							/>
							{hostedZones.length > 0 && hostedZoneId && (
								<p className="text-xs text-muted-foreground">
									Auto-filled from zone. You can edit it.
								</p>
							)}
						</div>
					</div>

					<div className="space-y-2">
						<div className="flex items-center justify-between p-3 border border-border/50 rounded-lg">
							<div className="flex items-center gap-1.5">
								<div>
									<p className="text-sm font-medium">ACM Certificate</p>
									<p className="text-[11px] text-muted-foreground">Free with AWS services</p>
								</div>
								<HelpTooltip topic="acm-certificate" />
							</div>
							<Switch checked={acmCertificate} onCheckedChange={onAcmCertificateChange} />
						</div>

						<div className="flex items-center justify-between p-3 border border-border/50 rounded-lg">
							<div className="flex items-center gap-1.5">
								<Shield className="h-3.5 w-3.5 text-muted-foreground" />
								<div>
									<p className="text-sm font-medium">CloudFront WAF</p>
									<p className="text-[11px] text-muted-foreground">~$5/mo per web ACL</p>
								</div>
								<HelpTooltip topic="cloudfront-waf" />
							</div>
							<Switch checked={cloudfrontWaf} onCheckedChange={onCloudfrontWafChange} />
						</div>

						<div className="flex items-center justify-between p-3 border border-border/50 rounded-lg">
							<div className="flex items-center gap-1.5">
								<Shield className="h-3.5 w-3.5 text-muted-foreground" />
								<div>
									<p className="text-sm font-medium">Application WAF</p>
									<p className="text-[11px] text-muted-foreground">~$5/mo per web ACL</p>
								</div>
								<HelpTooltip topic="application-waf" />
							</div>
							<Switch checked={applicationWaf} onCheckedChange={onApplicationWafChange} />
						</div>
					</div>
				</CardContent>
			)}
		</Card>
	);
}
