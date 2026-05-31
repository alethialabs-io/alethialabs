"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { CloudProviderMeta } from "@/lib/cloud-providers";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { SERVICE_TYPE_CONFIG, type ServiceInstance, type ServiceType } from "./service-card";

function CopyButton({ value }: { value: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			variant="ghost"
			size="icon"
			className="h-5 w-5 shrink-0"
			onClick={async () => {
				await navigator.clipboard.writeText(value);
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			}}
		>
			{copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
		</Button>
	);
}

interface FieldDef {
	key: string;
	label: string;
	mono?: boolean;
	format?: (v: unknown) => string | null;
}

const FIELD_DEFS: Record<ServiceType, FieldDef[]> = {
	database: [
		{ key: "engine", label: "Engine", mono: true },
		{ key: "engine_version", label: "Version", mono: true },
		{ key: "min_capacity", label: "Min Capacity" },
		{ key: "max_capacity", label: "Max Capacity" },
		{ key: "port", label: "Port", mono: true },
		{ key: "backup_retention_days", label: "Backup Retention", format: (v) => v != null ? `${v} days` : null },
		{ key: "iam_auth", label: "IAM Auth", format: (v) => v === true ? "Enabled" : v === false ? "Disabled" : null },
	],
	cache: [
		{ key: "engine", label: "Engine", mono: true },
		{ key: "node_type", label: "Node Type", mono: true },
		{ key: "num_cache_nodes", label: "Nodes" },
		{ key: "multi_az", label: "Multi-AZ", format: (v) => v === true ? "Yes" : v === false ? "No" : null },
	],
	queue: [
		{ key: "fifo", label: "Type", format: (v) => v === true ? "FIFO" : "Standard" },
		{ key: "visibility_timeout", label: "Visibility Timeout", format: (v) => v != null ? `${v}s` : null },
		{ key: "message_retention", label: "Message Retention", format: (v) => v != null ? `${v}s` : null },
		{ key: "delay_seconds", label: "Delay", format: (v) => v != null ? `${v}s` : null },
	],
	topic: [
		{ key: "subscriptions", label: "Subscriptions", format: (v) => {
			const subs = v as Array<{ protocol: string; endpoint: string }> | null;
			if (!subs || subs.length === 0) return "None";
			return subs.map((s) => `${s.protocol}: ${s.endpoint}`).join(", ");
		}},
	],
	nosql_table: [
		{ key: "hash_key", label: "Hash Key", mono: true },
		{ key: "hash_key_type", label: "Hash Key Type", mono: true },
		{ key: "range_key", label: "Range Key", mono: true },
		{ key: "range_key_type", label: "Range Key Type", mono: true },
		{ key: "billing_mode", label: "Billing", format: (v) => v === "PROVISIONED" ? "Provisioned" : "On-Demand" },
		{ key: "point_in_time_recovery", label: "PITR", format: (v) => v === true ? "Enabled" : v === false ? "Disabled" : null },
		{ key: "table_type", label: "Table Type" },
	],
	secret: [
		{ key: "length", label: "Length", format: (v) => v != null ? `${v} characters` : null },
		{ key: "generate", label: "Auto Generate", format: (v) => v === true ? "Yes" : "No" },
		{ key: "special_chars", label: "Special Chars", format: (v) => v === true ? "Yes" : v === false ? "No" : null },
	],
};

const ENDPOINT_KEYS: Partial<Record<ServiceType, string[]>> = {
	database: ["endpoint", "reader_endpoint"],
	cache: ["endpoint"],
};

interface ServicePopoverProps {
	type: ServiceType;
	service: ServiceInstance;
	providerMeta: CloudProviderMeta;
	capacityUnit?: string;
}

export function ServicePopover({ type, service, providerMeta, capacityUnit }: ServicePopoverProps) {
	const config = SERVICE_TYPE_CONFIG[type];
	const Icon = config.icon;
	const label = providerMeta[config.metaKey] as string;
	const fields = FIELD_DEFS[type];
	const endpointKeys = ENDPOINT_KEYS[type] ?? [];

	const endpoints = endpointKeys
		.map((key) => ({ key, value: service[key] as string | null }))
		.filter((e) => e.value);

	const status = service.status as string | null;
	const statusMessage = service.status_message as string | null;
	const cost = service.estimated_monthly_cost as number | null;

	return (
		<div className="space-y-0">
			{/* Header */}
			<div className="flex items-center gap-2 px-4 py-3 border-b">
				<Icon className="h-4 w-4 text-muted-foreground" />
				<span className="text-sm font-medium font-mono">{service.name}</span>
				{status && (
					<Badge variant="outline" className="text-[10px] py-0 ml-auto">
						{status}
					</Badge>
				)}
			</div>

			{/* Fields */}
			<div className="px-4 py-3 space-y-2">
				<p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{label} Configuration</p>
				{fields.flatMap((field) => {
					const raw = service[field.key];
					if (raw == null && !field.format) return [];
					const display: string = field.format ? (field.format(raw) ?? "") : String(raw ?? "—");
					if (!display) return [];
					return [
						<div key={field.key} className="flex items-center justify-between">
							<span className="text-[11px] text-muted-foreground">{field.label}</span>
							<span className={`text-xs font-medium ${field.mono ? "font-mono" : ""}`}>{display}</span>
						</div>,
					];
				})}
				{capacityUnit && type === "database" && (
					<div className="flex items-center justify-between">
						<span className="text-[11px] text-muted-foreground">Capacity Unit</span>
						<span className="text-xs font-medium font-mono">{capacityUnit}</span>
					</div>
				)}
			</div>

			{/* Endpoints */}
			{endpoints.length > 0 && (
				<>
					<Separator />
					<div className="px-4 py-3 space-y-2">
						<p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Endpoints</p>
						{endpoints.map((ep) => (
							<div key={ep.key} className="space-y-0.5">
								<span className="text-[11px] text-muted-foreground capitalize">{ep.key.replace("_", " ")}</span>
								<div className="flex items-center gap-1">
									<code className="flex-1 text-[11px] bg-muted px-2 py-1 rounded font-mono truncate border border-border/50">
										{ep.value}
									</code>
									<CopyButton value={ep.value!} />
								</div>
							</div>
						))}
					</div>
				</>
			)}

			{/* Cost */}
			{cost != null && (
				<>
					<Separator />
					<div className="flex items-center justify-between px-4 py-2.5 bg-muted/30">
						<span className="text-[11px] text-muted-foreground">Est. Monthly Cost</span>
						<span className="text-xs font-medium font-mono">${cost.toFixed(2)}/mo</span>
					</div>
				</>
			)}

			{/* Status Message */}
			{statusMessage && (
				<>
					<Separator />
					<div className="px-4 py-2.5">
						<p className="text-[11px] text-muted-foreground">{statusMessage}</p>
					</div>
				</>
			)}
		</div>
	);
}
