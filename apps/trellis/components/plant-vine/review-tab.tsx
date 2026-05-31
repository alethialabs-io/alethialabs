"use client";

import { useProviderMeta, DB_CAPACITY } from "@/lib/cloud-providers";
import { useProviderSlug } from "@/lib/cloud-providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useVineStore } from "./use-vine-store";
import {
	CheckCircle2,
	Cloud,
	Database,
	Globe,
	Key,
	Layers,
	Loader2,
	MessageSquare,
	Network,
	Rocket,
	Server,
	Table2,
} from "lucide-react";
import { useFormContext } from "react-hook-form";
import type { VineFormData } from "@/lib/validations/vine-form.schema";

interface SummaryRowProps {
	label: string;
	value: string | number | null | undefined;
	mono?: boolean;
}

function SummaryRow({ label, value, mono }: SummaryRowProps) {
	return (
		<div className="flex justify-between items-center text-xs py-1">
			<span className="text-muted-foreground">{label}</span>
			<span className={`text-foreground ${mono ? "font-mono" : ""}`}>{value ?? "—"}</span>
		</div>
	);
}

/** Review tab showing a summary of all configured components + submit button. */
export function ReviewTab() {
	const { watch } = useFormContext<VineFormData>();
	const store = useVineStore();
	const meta = useProviderMeta();
	const provider = useProviderSlug();
	const capacity = DB_CAPACITY[provider];

	const vine = watch("vine");
	const network = watch("network");
	const cluster = watch("cluster");
	const dns = watch("dns");
	const databases = watch("databases") || [];
	const caches = watch("caches") || [];
	const queues = watch("queues") || [];
	const topics = watch("topics") || [];
	const nosqlTables = watch("nosql_tables") || [];
	const secrets = watch("secrets") || [];

	const instanceTypes = (cluster.instance_types || []) as string[];

	return (
		<div className="space-y-4">
			<Card>
				<CardHeader className="pb-3">
					<CardTitle className="text-sm flex items-center gap-2">
						<CheckCircle2 className="h-4 w-4 text-muted-foreground" />
						Configuration Summary
					</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					{/* Project */}
					<div>
						<div className="flex items-center gap-1.5 mb-2">
							<Layers className="h-3.5 w-3.5 text-muted-foreground" />
							<span className="text-xs font-medium">Project</span>
						</div>
						<SummaryRow label="Name" value={vine.project_name} mono />
						<SummaryRow label="Environment" value={vine.environment_stage} />
						<SummaryRow label="Region" value={vine.region} mono />
						<SummaryRow label="Provider" value={meta.shortName} />
					</div>

					<Separator />

					{/* Network */}
					<div>
						<div className="flex items-center gap-1.5 mb-2">
							<Network className="h-3.5 w-3.5 text-muted-foreground" />
							<span className="text-xs font-medium">{meta.networkName}</span>
						</div>
						<SummaryRow label="Mode" value={network.provision_network ? "Create New" : "Use Existing"} />
						{network.provision_network && <SummaryRow label="CIDR" value={network.cidr_block} mono />}
						<SummaryRow label="NAT" value={network.single_nat_gateway ? "Single" : "Per-AZ"} />
					</div>

					<Separator />

					{/* Cluster */}
					<div>
						<div className="flex items-center gap-1.5 mb-2">
							<Server className="h-3.5 w-3.5 text-muted-foreground" />
							<span className="text-xs font-medium">{meta.clusterService} Cluster</span>
						</div>
						<SummaryRow label="Version" value={cluster.cluster_version} mono />
						<SummaryRow label="Nodes" value={`${cluster.node_min_size}-${cluster.node_max_size} (desired: ${cluster.node_desired_size})`} />
						<div className="flex gap-1 mt-1 flex-wrap">
							{instanceTypes.map((t) => (
								<Badge key={t} variant="outline" className="text-[10px] font-mono">{t}</Badge>
							))}
						</div>
					</div>

					{/* Services */}
					{(databases.length > 0 || caches.length > 0 || nosqlTables.length > 0 || queues.length > 0 || topics.length > 0) && (
						<>
							<Separator />
							<div>
								<div className="flex items-center gap-1.5 mb-2">
									<Database className="h-3.5 w-3.5 text-muted-foreground" />
									<span className="text-xs font-medium">Services</span>
								</div>
								{databases.map((db, i) => (
									<SummaryRow key={i} label={`Database: ${db.name}`} value={`${db.engine} (${db.min_capacity}-${db.max_capacity} ${capacity.unit})`} />
								))}
								{caches.map((c, i) => (
									<SummaryRow key={i} label={`Cache: ${c.name}`} value={`${c.engine} ${c.node_type}`} />
								))}
								{nosqlTables.map((t, i) => (
									<SummaryRow key={i} label={`NoSQL: ${t.name}`} value={`${t.hash_key} (${t.billing_mode})`} />
								))}
								{queues.length > 0 && <SummaryRow label="Queues" value={`${queues.length} queue${queues.length > 1 ? "s" : ""}`} />}
								{topics.length > 0 && <SummaryRow label="Topics" value={`${topics.length} topic${topics.length > 1 ? "s" : ""}`} />}
							</div>
						</>
					)}

					{/* Security */}
					{(dns.enabled || secrets.length > 0) && (
						<>
							<Separator />
							<div>
								<div className="flex items-center gap-1.5 mb-2">
									<Globe className="h-3.5 w-3.5 text-muted-foreground" />
									<span className="text-xs font-medium">Security</span>
								</div>
								{dns.enabled && <SummaryRow label="DNS" value={dns.domain_name || "Enabled"} />}
								{secrets.length > 0 && <SummaryRow label="Secrets" value={`${secrets.length} secret${secrets.length > 1 ? "s" : ""}`} />}
							</div>
						</>
					)}
				</CardContent>
			</Card>

			{/* Submit */}
			<div className="flex items-center justify-end gap-4">
				{store.error && (
					<p className="text-sm text-destructive">{store.error}</p>
				)}
				<Button
					type="submit"
					disabled={store.isLoading}
					className="min-w-[160px]"
				>
					{store.isLoading ? (
						<>
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							Planting...
						</>
					) : (
						<>
							<Rocket className="mr-2 h-4 w-4" />
							Plant Vine
						</>
					)}
				</Button>
			</div>
		</div>
	);
}
