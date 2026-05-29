"use client";

import { Switch } from "@/components/ui/switch";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	EksAdminsInput,
	parseEksAdmins,
	serializeEksAdmins,
} from "./eks-admins-input";
import {
	SesConfigInput,
	parseSesConfig,
	serializeSesConfig,
} from "./ses-config-input";
import type { CachedAwsResources } from "@/app/server/actions/aws/resources";
import { UseFormReturn } from "react-hook-form";
import type { ConfigFormValues } from "./configuration-form";
import { useEffect, useRef, useState } from "react";

type EksAdmin = { username: string; path: string };
type SesQueue = { name: string; visibility_timeout: number };
type SesTopic = { name: string; subscriptions: string[] };

interface SectionAdvancedProps {
	form: UseFormReturn<ConfigFormValues>;
	awsResources: CachedAwsResources | null;
}

export function SectionAdvanced({
	form,
	awsResources,
}: SectionAdvancedProps) {
	const enableRedis = form.watch("enable_redis") ?? false;
	const enableWaf = form.watch("enable_cloudfront_waf") ?? false;
	const enableKarpenter = form.watch("enable_karpenter") ?? true;
	const region = form.watch("aws_region");

	const initializedRef = useRef(false);
	const [eksAdmins, setEksAdmins] = useState<EksAdmin[]>([]);
	const [sesQueues, setSesQueues] = useState<SesQueue[]>([]);
	const [sesTopics, setSesTopics] = useState<SesTopic[]>([]);

	useEffect(() => {
		if (initializedRef.current) return;
		initializedRef.current = true;

		const eksYaml = form.getValues("eks_cluster_admins") ?? "";
		const sesYaml = form.getValues("ses_queues_topics") ?? "";

		setEksAdmins(parseEksAdmins(eksYaml));
		const parsed = parseSesConfig(sesYaml);
		setSesQueues(parsed.queues);
		setSesTopics(parsed.topics);
	}, [form]);

	useEffect(() => {
		form.setValue("eks_cluster_admins", serializeEksAdmins(eksAdmins));
	}, [eksAdmins, form]);

	useEffect(() => {
		form.setValue(
			"ses_queues_topics",
			serializeSesConfig(sesQueues, sesTopics),
		);
	}, [sesQueues, sesTopics, form]);

	// Collect known CIDRs from cached VPCs/subnets for CIDR selector
	const knownCidrs: string[] = [];
	if (awsResources && region) {
		const regionVpcs = awsResources.vpcs?.[region] ?? [];
		for (const vpc of regionVpcs) {
			if (!knownCidrs.includes(vpc.CIDR)) knownCidrs.push(vpc.CIDR);
		}
		const regionSubnets = awsResources.subnets?.[region] ?? {};
		for (const vpcSubnets of Object.values(regionSubnets)) {
			for (const subnet of vpcSubnets) {
				if (!knownCidrs.includes(subnet.CIDR))
					knownCidrs.push(subnet.CIDR);
			}
		}
	}

	const redisCidr = form.watch("redis_allowed_cidr_blocks") ?? "";

	return (
		<Card className="shadow-sm border border-border/40">
			<CardHeader className="bg-muted/5 border-b border-border/40 pb-4">
				<CardTitle className="text-base font-medium">
					Advanced Configuration
				</CardTitle>
				<CardDescription className="text-xs">
					EKS access, messaging, caching, and feature flags.
				</CardDescription>
			</CardHeader>
			<CardContent className="pt-6 space-y-6">
				{/* EKS Cluster Admins */}
				<div className="space-y-2">
					<p className="text-xs font-medium">EKS Cluster Admins</p>
					<p className="text-[11px] text-muted-foreground">
						Users with admin access to the EKS cluster. Select
						from previously used or add new.
					</p>
					<EksAdminsInput
						value={eksAdmins}
						onChange={setEksAdmins}
					/>
				</div>

				{/* SES Queues & Topics */}
				<div className="space-y-2">
					<p className="text-xs font-medium">
						SQS Queues & SNS Topics
					</p>
					<p className="text-[11px] text-muted-foreground">
						Messaging infrastructure for your application.
					</p>
					<SesConfigInput
						queues={sesQueues}
						topics={sesTopics}
						onQueuesChange={setSesQueues}
						onTopicsChange={setSesTopics}
					/>
				</div>

				{/* Feature Toggles */}
				<div className="space-y-3">
					<p className="text-xs font-medium">Feature Flags</p>

					<div className="flex items-center justify-between p-3 rounded-md border border-border/40">
						<div>
							<p className="text-sm font-medium">Karpenter</p>
							<p className="text-xs text-muted-foreground">
								Kubernetes node auto-scaling
							</p>
						</div>
						<Switch
							checked={enableKarpenter}
							onCheckedChange={(checked) =>
								form.setValue("enable_karpenter", checked)
							}
						/>
					</div>

					<div className="flex items-center justify-between p-3 rounded-md border border-border/40">
						<div>
							<p className="text-sm font-medium">
								CloudFront WAF
							</p>
							<p className="text-xs text-muted-foreground">
								Web Application Firewall
							</p>
						</div>
						<Switch
							checked={enableWaf}
							onCheckedChange={(checked) =>
								form.setValue(
									"enable_cloudfront_waf",
									checked,
								)
							}
						/>
					</div>

					<div className="flex items-center justify-between p-3 rounded-md border border-border/40">
						<div>
							<p className="text-sm font-medium">
								ElastiCache Redis
							</p>
							<p className="text-xs text-muted-foreground">
								In-memory caching cluster
							</p>
						</div>
						<Switch
							checked={enableRedis}
							onCheckedChange={(checked) =>
								form.setValue("enable_redis", checked)
							}
						/>
					</div>

					{enableRedis && (
						<div className="pl-3 border-l-2 border-border/40 space-y-2">
							<p className="text-xs font-medium">
								Allowed CIDR Blocks
							</p>
							{knownCidrs.length > 0 ? (
								<Select
									value={redisCidr || undefined}
									onValueChange={(cidr) =>
										form.setValue(
											"redis_allowed_cidr_blocks",
											cidr,
										)
									}
								>
									<SelectTrigger className="h-9 text-sm font-mono">
										<SelectValue placeholder="Select CIDR" />
									</SelectTrigger>
									<SelectContent>
										{knownCidrs.map((cidr) => (
											<SelectItem
												key={cidr}
												value={cidr}
											>
												{cidr}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							) : (
								<input
									type="text"
									placeholder="10.0.0.0/16"
									className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm font-mono shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
									value={redisCidr}
									onChange={(e) =>
										form.setValue(
											"redis_allowed_cidr_blocks",
											e.target.value,
										)
									}
								/>
							)}
						</div>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
