"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { StatusBadge } from "@/components/ui/status-badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { CloudProviderMeta } from "@/lib/cloud-providers";
import {
	Database,
	Lock,
	MessageSquare,
	Table,
	Zap,
	type LucideIcon,
} from "lucide-react";
import { ServicePopover } from "./service-popover";

export type ServiceType =
	| "database"
	| "cache"
	| "queue"
	| "topic"
	| "nosql_table"
	| "secret";

export interface ServiceInstance {
	id: string;
	name: string;
	status: string | null;
	estimated_monthly_cost?: number | null;
	[key: string]: unknown;
}

export const SERVICE_TYPE_CONFIG: Record<
	ServiceType,
	{ icon: LucideIcon; metaKey: keyof CloudProviderMeta }
> = {
	database: { icon: Database, metaKey: "dbService" },
	cache: { icon: Zap, metaKey: "cacheService" },
	queue: { icon: MessageSquare, metaKey: "queueService" },
	topic: { icon: MessageSquare, metaKey: "topicService" },
	nosql_table: { icon: Table, metaKey: "nosqlService" },
	secret: { icon: Lock, metaKey: "secretsService" },
};

export function getConfigSummary(
	type: ServiceType,
	service: ServiceInstance,
	capacityUnit?: string,
): string {
	switch (type) {
		case "database": {
			const engine = (service.engine as string) ?? "";
			const min = service.min_capacity;
			const max = service.max_capacity;
			const unit = capacityUnit ?? "ACU";
			return min != null && max != null
				? `${engine} · ${min}-${max} ${unit}`
				: engine;
		}
		case "cache": {
			const engine = (service.engine as string) ?? "";
			const nodeType = (service.node_type as string) ?? "";
			const count = service.num_cache_nodes as number | null;
			return count && count > 1
				? `${engine} · ${nodeType} × ${count}`
				: `${engine} · ${nodeType}`;
		}
		case "queue": {
			const ordered = service.ordered as boolean | null;
			const timeout = service.visibility_timeout as number | null;
			return `${ordered ? "FIFO" : "Standard"}${timeout ? ` · ${timeout}s timeout` : ""}`;
		}
		case "topic": {
			const subs = service.subscriptions as unknown[] | null;
			return `${subs?.length ?? 0} subscription${(subs?.length ?? 0) !== 1 ? "s" : ""}`;
		}
		case "nosql_table": {
			const hashKey = (service.partition_key as string) ?? "";
			const billing = service.capacity_mode as string | null;
			return `${hashKey} (${billing === "provisioned" ? "Provisioned" : "On-Demand"})`;
		}
		case "secret": {
			const length = service.length as number | null;
			const generate = service.generate as boolean | null;
			return `${length ?? "?"} chars${generate ? " · Auto-generated" : ""}`;
		}
	}
}

interface ServiceCardProps {
	type: ServiceType;
	service: ServiceInstance;
	providerMeta: CloudProviderMeta;
	capacityUnit?: string;
}

export function ServiceCard({ type, service, providerMeta, capacityUnit }: ServiceCardProps) {
	const config = SERVICE_TYPE_CONFIG[type];
	const Icon = config.icon;
	const summary = getConfigSummary(type, service, capacityUnit);

	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="w-full text-left rounded-lg border border-border/60 bg-card p-4 space-y-2 cursor-pointer hover:border-border hover:shadow-sm transition-all"
				>
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-2 min-w-0">
							<Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
							<span className="text-sm font-mono font-medium truncate">
								{service.name}
							</span>
						</div>
						{service.status && (
							<StatusBadge status={service.status} className="shrink-0 ml-2" />
						)}
					</div>
					<p className="text-xs text-muted-foreground truncate">{summary}</p>
					{service.estimated_monthly_cost != null && (
						<p className="text-[11px] font-mono text-muted-foreground">
							~${Math.round(service.estimated_monthly_cost)}/mo
						</p>
					)}
				</button>
			</PopoverTrigger>
			<PopoverContent side="right" align="start" className="w-80 p-0">
				<ServicePopover type={type} service={service} providerMeta={providerMeta} capacityUnit={capacityUnit} />
			</PopoverContent>
		</Popover>
	);
}
