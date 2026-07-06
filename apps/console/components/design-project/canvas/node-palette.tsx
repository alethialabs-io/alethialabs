"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	Archive,
	ArrowLeft,
	HardDrive,
	Package,
	type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@repo/ui/command";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { NODE_REGISTRY } from "./graph/node-registry";
import type { NodeKind } from "./graph/types";

interface NodePaletteProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	identities: CloudIdentityOption[];
}

/** One selectable service in the Add palette. `kind` is the canvas node; entries with
 * no `kind` are surfaced as roadmap items (no Terraform module yet). */
interface ServiceEntry {
	id: string;
	label: string;
	subtitle: string;
	icon: LucideIcon;
	kind?: NodeKind;
	comingSoon?: boolean;
}

/** Grouped catalog backing the Add palette — mirrors the provisionable service types
 * (DATA / STORAGE / MESSAGING / …). Subtitles name the cloud-indifferent options. */
const SERVICE_GROUPS: { title: string; items: ServiceEntry[] }[] = [
	{
		title: "Data",
		items: [
			{ id: "database", label: "Database", subtitle: "PostgreSQL · MySQL", kind: "database", icon: NODE_REGISTRY.database.icon },
			{ id: "cache", label: "Cache", subtitle: "Redis · Valkey", kind: "cache", icon: NODE_REGISTRY.cache.icon },
			{ id: "nosql", label: "NoSQL table", subtitle: "DynamoDB · Firestore · Cosmos DB", kind: "nosql", icon: NODE_REGISTRY.nosql.icon },
		],
	},
	{
		title: "Storage",
		items: [
			{ id: "bucket", label: "Bucket", subtitle: "Object storage for files and assets", icon: Archive, comingSoon: true },
			{ id: "volume", label: "Volume", subtitle: "Persistent block storage for containers", icon: HardDrive, comingSoon: true },
		],
	},
	{
		title: "Messaging",
		items: [
			{ id: "queue", label: "Queue", subtitle: "SQS · Pub/Sub · Service Bus", kind: "queue", icon: NODE_REGISTRY.queue.icon },
			{ id: "topic", label: "Topic", subtitle: "Pub/Sub topics & subscriptions", kind: "topic", icon: NODE_REGISTRY.topic.icon },
		],
	},
	{
		title: "Security",
		items: [
			{ id: "secret", label: "Secret", subtitle: "Managed secrets & credentials", kind: "secret", icon: NODE_REGISTRY.secret.icon },
		],
	},
	{
		title: "Networking",
		items: [
			{ id: "network", label: "Network", subtitle: "VPC / VNet & subnets", kind: "network", icon: NODE_REGISTRY.network.icon },
			{ id: "dns", label: "DNS", subtitle: "DNS records, certificates & WAF", kind: "dns", icon: NODE_REGISTRY.dns.icon },
		],
	},
	{
		title: "Compute",
		items: [
			{ id: "cluster", label: "Cluster", subtitle: "Managed Kubernetes (EKS · GKE · AKS)", kind: "cluster", icon: NODE_REGISTRY.cluster.icon },
		],
	},
	{
		title: "DevOps",
		items: [
			{ id: "repositories", label: "Repository", subtitle: "GitOps app deployment repo", kind: "repositories", icon: NODE_REGISTRY.repositories.icon },
			{ id: "registry", label: "Container registry", subtitle: "Private container images", icon: Package, comingSoon: true },
		],
	},
];

/**
 * The Add-service command palette: a searchable, grouped menu over every provisionable
 * service. Selecting one drops its node on the canvas and opens its config sheet. Kinds with
 * variants (e.g. Database → engine) route through a second step first. Singletons already on
 * the canvas are disabled; roadmap items (no module yet) show "Soon".
 */
export function NodePalette({ open, onOpenChange, identities }: NodePaletteProps) {
	const addNode = useCanvasStore((s) => s.addNode);
	const addNodeWithConfig = useCanvasStore((s) => s.addNodeWithConfig);
	const nodes = useCanvasStore((s) => s.nodes);
	// When set, the palette shows the variant step for this kind (e.g. pick a DB engine).
	const [variantKind, setVariantKind] = useState<NodeKind | null>(null);

	/** Reset the variant step whenever the dialog closes. */
	const handleOpenChange = (o: boolean) => {
		if (!o) setVariantKind(null);
		onOpenChange(o);
	};

	const add = (entry: ServiceEntry) => {
		if (entry.comingSoon || !entry.kind) return;
		if (NODE_REGISTRY[entry.kind].variants) {
			setVariantKind(entry.kind);
			return;
		}
		addNode(entry.kind);
		handleOpenChange(false);
	};

	/** Commit a variant choice: add the node pre-filled for it, then open its sheet. */
	const pickVariant = (kind: NodeKind, value: string) => {
		const { key } = NODE_REGISTRY[kind].variants ?? { key: "" };
		addNodeWithConfig(kind, { [key]: value });
		handleOpenChange(false);
	};

	const noCloud = identities.length === 0;
	const variantDef = variantKind ? NODE_REGISTRY[variantKind] : null;

	return (
		<CommandDialog
			open={open}
			onOpenChange={handleOpenChange}
			title={variantDef ? `Choose ${variantDef.label.toLowerCase()} type` : "Add a service"}
			description="Search and add infrastructure to your project."
			className="sm:max-w-xl"
		>
			{variantDef && variantKind ? (
				<>
					<CommandInput
						placeholder={`Choose a ${variantDef.label.toLowerCase()} type…`}
					/>
					<CommandList className="max-h-[60vh]">
						<CommandEmpty>No option matches.</CommandEmpty>
						<CommandGroup>
							<CommandItem
								value="__back"
								onSelect={() => setVariantKind(null)}
								className="gap-3 text-muted-foreground"
							>
								<ArrowLeft className="h-4 w-4 shrink-0" />
								<span className="text-sm">Back to services</span>
							</CommandItem>
						</CommandGroup>
						<CommandSeparator />
						<CommandGroup heading={`${variantDef.label} type`}>
							{variantDef.variants?.options.map((opt) => {
								const Icon = variantDef.icon;
								return (
									<CommandItem
										key={opt.value}
										value={`${opt.label} ${opt.description}`}
										onSelect={() => pickVariant(variantKind, opt.value)}
										className="gap-3"
									>
										<Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
										<div className="min-w-0 flex-1">
											<div className="text-sm font-medium">{opt.label}</div>
											<div className="truncate text-xs text-muted-foreground">
												{opt.description}
											</div>
										</div>
									</CommandItem>
								);
							})}
						</CommandGroup>
					</CommandList>
				</>
			) : (
				<>
					<CommandInput placeholder="Search services — database, redis, bucket, queue…" />
					<CommandList className="max-h-[60vh]">
						<CommandEmpty>No service matches.</CommandEmpty>
						{noCloud && (
							<p className="px-3 py-2 text-xs text-muted-foreground">
								Tip: connect a cloud account to provision these for real — you can still
								design now.
							</p>
						)}
						{SERVICE_GROUPS.map((group) => (
							<CommandGroup key={group.title} heading={group.title}>
								{group.items.map((entry) => {
									const Icon = entry.icon;
									const onCanvas =
										!!entry.kind &&
										NODE_REGISTRY[entry.kind].cardinality === "singleton" &&
										nodes.some((n) => n.data.kind === entry.kind);
									const disabled = entry.comingSoon || onCanvas;
									return (
										<CommandItem
											key={entry.id}
											value={`${entry.label} ${entry.subtitle}`}
											disabled={disabled}
											onSelect={() => add(entry)}
											className="gap-3"
										>
											<Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
											<div className="min-w-0 flex-1">
												<div className="text-sm font-medium">{entry.label}</div>
												<div className="truncate text-xs text-muted-foreground">
													{entry.subtitle}
												</div>
											</div>
											{entry.comingSoon ? (
												<span className="font-mono text-[10px] uppercase text-muted-foreground">
													Soon
												</span>
											) : onCanvas ? (
												<span className="font-mono text-[10px] text-muted-foreground">
													on canvas
												</span>
											) : null}
										</CommandItem>
									);
								})}
							</CommandGroup>
						))}
					</CommandList>
				</>
			)}
		</CommandDialog>
	);
}
