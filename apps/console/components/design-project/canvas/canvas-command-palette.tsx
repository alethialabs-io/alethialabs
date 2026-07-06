"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@repo/ui/command";
import {
	PROVIDERS,
	getProvider,
	type CloudProviderMeta,
} from "@/lib/cloud-providers";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";
import {
	ADDABLE_KINDS,
	NODE_REGISTRY,
} from "./graph/node-registry";
import type { NodeKind } from "./graph/types";

/** Maps a node kind to its provider-specific service-name field. */
const SERVICE_FIELD: Partial<Record<NodeKind, keyof CloudProviderMeta>> = {
	cluster: "clusterService",
	network: "networkName",
	database: "dbService",
	cache: "cacheService",
	queue: "queueService",
	topic: "topicService",
	nosql: "nosqlService",
	dns: "dnsService",
	secret: "secretsService",
};

/** Hand-curated search synonyms so real service names / tech terms match. */
const SYNONYMS: Partial<Record<NodeKind, string[]>> = {
	database: ["rds", "postgres", "postgresql", "mysql", "sql", "db", "relational"],
	cache: ["redis", "valkey", "in-memory"],
	dns: ["domain", "cloudflare", "records"],
	cluster: ["kubernetes", "k8s", "compute", "nodes", "workload"],
	queue: ["messaging", "fifo"],
	topic: ["pubsub", "events", "fan-out"],
	nosql: ["dynamodb", "firestore", "cosmos", "document", "key-value"],
	secret: ["secrets", "credentials", "vault", "password"],
	network: ["vpc", "vnet", "subnet", "cidr"],
	repositories: ["repo", "git", "gitops", "argocd", "deploy"],
};

/** All searchable keywords for a kind: provider service names (every cloud) + synonyms. */
function keywordsFor(kind: NodeKind): string[] {
	const field = SERVICE_FIELD[kind];
	const serviceNames = field
		? Object.values(PROVIDERS)
				.map((p) => p[field])
				.filter((v): v is string => typeof v === "string" && v !== "—")
		: [];
	return Array.from(
		new Set([
			NODE_REGISTRY[kind].label,
			...serviceNames,
			...(SYNONYMS[kind] ?? []),
		]),
	);
}

interface CanvasCommandPaletteProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSave: () => void;
	/** Optional — only present while the legacy form view still exists. */
	onToggleView?: () => void;
	onFitView: () => void;
	onAskAi: () => void;
}

/** ⌘K command menu: search services by name, jump to nodes, run actions. */
export function CanvasCommandPalette({
	open,
	onOpenChange,
	onSave,
	onToggleView,
	onFitView,
	onAskAi,
}: CanvasCommandPaletteProps) {
	const addNode = useCanvasStore((s) => s.addNode);
	const openInspector = useCanvasStore((s) => s.openInspector);
	const undo = useCanvasStore((s) => s.undo);
	const redo = useCanvasStore((s) => s.redo);
	const nodes = useCanvasStore((s) => s.nodes);
	const coreProvider =
		useCanvasStore((s) => s.getEffectiveProvider(PROJECT_NODE_ID)) ?? "aws";
	const meta = getProvider(coreProvider);

	const run = (fn: () => void) => {
		fn();
		onOpenChange(false);
	};

	const serviceItem = (kind: NodeKind) => {
		const def = NODE_REGISTRY[kind];
		const Icon = def.icon;
		const field = SERVICE_FIELD[kind];
		const serviceName = field ? meta[field] : null;
		return (
			<CommandItem
				key={kind}
				value={`add-${kind}`}
				keywords={keywordsFor(kind)}
				onSelect={() => run(() => addNode(kind))}
			>
				<Icon className="h-4 w-4" />
				<span>Add {def.label}</span>
				{serviceName && serviceName !== "—" && (
					<span className="ml-auto font-mono text-[11px] text-muted-foreground">
						{serviceName}
					</span>
				)}
			</CommandItem>
		);
	};

	const coreKinds = ADDABLE_KINDS.filter(
		(k) => NODE_REGISTRY[k].classification === "core",
	);
	const peripheryKinds = ADDABLE_KINDS.filter(
		(k) => NODE_REGISTRY[k].classification === "periphery",
	);
	const placedNodes = nodes.filter((n) => n.id !== PROJECT_NODE_ID);

	return (
		<CommandDialog open={open} onOpenChange={onOpenChange}>
			<CommandInput placeholder="Search services and actions…" />
			<CommandList>
				<CommandEmpty>No results.</CommandEmpty>

				<CommandGroup heading="Core services">
					{coreKinds.map(serviceItem)}
				</CommandGroup>
				<CommandGroup heading="Periphery">
					{peripheryKinds.map(serviceItem)}
				</CommandGroup>

				{placedNodes.length > 0 && (
					<CommandGroup heading="Jump to">
						{placedNodes.map((n) => {
							const def = NODE_REGISTRY[n.data.kind];
							const Icon = def.icon;
							const name =
								(n.data.config.name as string) ||
								(n.data.config.project_name as string) ||
								def.label;
							return (
								<CommandItem
									key={n.id}
									value={`jump-${n.id}`}
									keywords={[def.label, name]}
									onSelect={() =>
										run(() => {
											openInspector(n.id);
										})
									}
								>
									<Icon className="h-4 w-4" />
									<span>{name}</span>
									<span className="ml-auto font-mono text-[11px] text-muted-foreground">
										{def.label}
									</span>
								</CommandItem>
							);
						})}
					</CommandGroup>
				)}

				<CommandGroup heading="Actions">
					<CommandItem value="ask-ai" onSelect={() => run(onAskAi)}>
						Ask AI
					</CommandItem>
					<CommandItem value="save" onSelect={() => run(onSave)}>
						Save project
					</CommandItem>
					<CommandItem value="fit-view" onSelect={() => run(onFitView)}>
						Fit view
					</CommandItem>
					<CommandItem value="undo" onSelect={() => run(undo)}>
						Undo
					</CommandItem>
					<CommandItem value="redo" onSelect={() => run(redo)}>
						Redo
					</CommandItem>
					{onToggleView && (
						<CommandItem value="toggle-form" onSelect={() => run(onToggleView)}>
							Switch to form
						</CommandItem>
					)}
				</CommandGroup>
			</CommandList>
		</CommandDialog>
	);
}
