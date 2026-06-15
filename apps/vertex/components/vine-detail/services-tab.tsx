"use client";

import { StatusBadge } from "@/components/ui/status-badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { CloudProviderMeta } from "@/lib/cloud-providers";
import { Layers } from "lucide-react";
import { ServicePopover } from "./service-popover";
import { SERVICE_TYPE_CONFIG, getConfigSummary, type ServiceInstance, type ServiceType } from "./service-card";

interface ServicesTabProps {
	components: {
		databases: ServiceInstance[];
		caches: ServiceInstance[];
		queues: ServiceInstance[];
		topics: ServiceInstance[];
		nosql_tables: ServiceInstance[];
		secrets: ServiceInstance[];
	};
	providerMeta: CloudProviderMeta;
	capacityUnit: string;
}

const SERVICE_ORDER: { key: keyof ServicesTabProps["components"]; type: ServiceType }[] = [
	{ key: "databases", type: "database" },
	{ key: "caches", type: "cache" },
	{ key: "queues", type: "queue" },
	{ key: "topics", type: "topic" },
	{ key: "nosql_tables", type: "nosql_table" },
	{ key: "secrets", type: "secret" },
];

export function ServicesTab({ components, providerMeta, capacityUnit }: ServicesTabProps) {
	const allServices: { type: ServiceType; service: ServiceInstance; label: string }[] = [];

	for (const { key, type } of SERVICE_ORDER) {
		const items = components[key];
		const config = SERVICE_TYPE_CONFIG[type];
		const label = providerMeta[config.metaKey] as string;
		for (const service of items) {
			allServices.push({ type, service, label });
		}
	}

	if (allServices.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center py-12 gap-2">
				<Layers className="h-6 w-6 text-muted-foreground/30" />
				<p className="text-xs text-muted-foreground">No services configured.</p>
			</div>
		);
	}

	return (
		<div className="space-y-3">
			<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
				Services ({allServices.length})
			</h3>
			<div className="flex flex-wrap gap-2">
				{allServices.map(({ type, service, label }) => {
					const config = SERVICE_TYPE_CONFIG[type];
					const Icon = config.icon;
					const summary = getConfigSummary(type, service, type === "database" ? capacityUnit : undefined);

					return (
						<Popover key={service.id}>
							<PopoverTrigger asChild>
								<button
									type="button"
									className="flex items-center gap-2 rounded-md border border-border/60 bg-card px-3 py-2 text-left hover:border-border hover:shadow-sm transition-all cursor-pointer"
								>
									<Icon className="h-3 w-3 text-muted-foreground shrink-0" />
									<div className="flex items-center gap-1.5 min-w-0">
										<span className="text-xs font-mono font-medium truncate">{service.name}</span>
										{service.status && (
											<StatusBadge status={service.status} className="shrink-0" />
										)}
									</div>
									<span className="text-[10px] text-muted-foreground truncate hidden sm:inline">{summary}</span>
								</button>
							</PopoverTrigger>
							<PopoverContent side="bottom" align="start" className="w-80 p-0">
								<ServicePopover type={type} service={service} providerMeta={providerMeta} capacityUnit={type === "database" ? capacityUnit : undefined} />
							</PopoverContent>
						</Popover>
					);
				})}
			</div>
		</div>
	);
}
