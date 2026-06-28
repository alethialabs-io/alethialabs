"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import { Alert, AlertDescription } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@repo/ui/sheet";
import { Switch } from "@repo/ui/switch";
import { RepositorySelector } from "@/components/repository-selector";
import {
	CACHE_NODE_TYPES,
	DB_CAPACITY,
	DB_ENGINES,
	INSTANCE_TYPES,
	K8S_VERSIONS,
	MESSAGING,
	NOSQL,
	REGION_LABELS,
	groupRegions,
	type CloudProviderSlug,
} from "@/lib/cloud-providers";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { CloudIdentitySelector } from "../cloud-identity-selector";
import { NODE_REGISTRY } from "./graph/node-registry";
import type { CanvasNode } from "./graph/types";

/** A labelled field row. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="space-y-1.5">
			<Label className="text-xs">{label}</Label>
			{children}
		</div>
	);
}

/** Region dropdown keyed by the node's effective provider. */
function RegionSelect({
	provider,
	value,
	onChange,
}: {
	provider: CloudProviderSlug;
	value: string;
	onChange: (v: string) => void;
}) {
	const groups = groupRegions(Object.keys(REGION_LABELS[provider] ?? {}), provider);
	return (
		<Select value={value || ""} onValueChange={onChange}>
			<SelectTrigger className="h-9 text-sm">
				<SelectValue placeholder="Region" />
			</SelectTrigger>
			<SelectContent>
				{groups.map((g) => (
					<SelectGroup key={g.group}>
						<SelectLabel>{g.group}</SelectLabel>
						{g.regions.map((r) => (
							<SelectItem key={r.value} value={r.value}>
								{r.label} ({r.value})
							</SelectItem>
						))}
					</SelectGroup>
				))}
			</SelectContent>
		</Select>
	);
}

interface NodeInspectorProps {
	identities: CloudIdentityOption[];
}

/** Right-side Sheet that configures the selected node. */
export function NodeInspector({ identities }: NodeInspectorProps) {
	const inspectorNodeId = useCanvasStore((s) => s.inspectorNodeId);
	const node = useCanvasStore((s) =>
		inspectorNodeId ? s.nodes.find((n) => n.id === inspectorNodeId) : undefined,
	);
	const openInspector = useCanvasStore((s) => s.openInspector);
	const updateNodeConfig = useCanvasStore((s) => s.updateNodeConfig);
	const setNodeIdentity = useCanvasStore((s) => s.setNodeIdentity);
	const getEffectiveProvider = useCanvasStore((s) => s.getEffectiveProvider);

	const core = useCanvasStore((s) => s.getCoreIdentity());
	const provider = node ? getEffectiveProvider(node.id) : null;
	const def = node ? NODE_REGISTRY[node.data.kind] : null;
	const gated =
		!!node &&
		def?.classification === "core" &&
		!!core &&
		(node.data.cloud_identity_id ?? core) !== core;

	return (
		<Sheet
			open={!!node}
			onOpenChange={(o) => {
				if (!o) openInspector(null);
			}}
		>
			<SheetContent
				side="right"
				className="w-[380px] gap-0 overflow-y-auto sm:max-w-[380px]"
			>
				{node && def && (
					<>
						<SheetHeader>
							<span className="vx-eyebrow">{def.eyebrow}</span>
							<SheetTitle className="text-base">
								{(node.data.config.name as string) ||
									(node.data.config.project_name as string) ||
									def.label}
							</SheetTitle>
							<SheetDescription className="text-xs">
								{def.classification === "root"
									? "Project basics and the stack's core cloud account."
									: def.classification === "core"
										? "Core resource — must run on the stack's cloud."
										: "Periphery — may run on any connected cloud."}
							</SheetDescription>
						</SheetHeader>

						<div className="space-y-5 px-4 pb-10">
							{gated && (
								<Alert variant="default" className="border-border bg-muted">
									<AlertDescription className="text-xs">
										This core resource sits on a different cloud than the stack.
										Hot cross-cloud data-plane edges are on the roadmap — it can be
										drawn, but the project will not provision until colocated.
									</AlertDescription>
								</Alert>
							)}

							{def.cloudScoped && (
								<IdentityField
									node={node}
									identities={identities}
									onPick={(id, prov) => setNodeIdentity(node.id, id, prov)}
									onInherit={() => setNodeIdentity(node.id, null, null)}
								/>
							)}

							<Fields
								node={node}
								provider={provider}
								onChange={(patch) => updateNodeConfig(node.id, patch)}
							/>
						</div>
					</>
				)}
			</SheetContent>
		</Sheet>
	);
}

/** Per-node cloud account selector (root sets the CORE; others may diverge). */
function IdentityField({
	node,
	identities,
	onPick,
	onInherit,
}: {
	node: CanvasNode;
	identities: CloudIdentityOption[];
	onPick: (id: string, provider: CloudProviderSlug) => void;
	onInherit: () => void;
}) {
	const isRoot = node.data.kind === "project";
	return (
		<Field label={isRoot ? "Cloud account (core)" : "Cloud account"}>
			<CloudIdentitySelector
				identities={identities}
				value={node.data.cloud_identity_id}
				onChange={onPick}
				manageGlobalStore={false}
			/>
			{!isRoot && node.data.cloud_identity_id && (
				<button
					type="button"
					onClick={onInherit}
					className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
				>
					Inherit project cloud
				</button>
			)}
		</Field>
	);
}

/** Renders the type-specific configuration fields for a node. */
function Fields({
	node,
	provider,
	onChange,
}: {
	node: CanvasNode;
	provider: CloudProviderSlug | null;
	onChange: (patch: Record<string, unknown>) => void;
}) {
	const c = node.data.config;

	if (node.data.kind === "project") {
		return (
			<>
				<Field label="Project name">
					<Input
						value={(c.project_name as string) ?? ""}
						maxLength={25}
						placeholder="my-project"
						className="h-9 font-mono text-sm"
						onChange={(e) =>
							onChange({ project_name: e.target.value.toLowerCase() })
						}
					/>
				</Field>
				<Field label="Environment">
					<Select
						value={(c.environment_stage as string) ?? "development"}
						onValueChange={(v) => onChange({ environment_stage: v })}
					>
						<SelectTrigger className="h-9 text-sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="development">Development</SelectItem>
							<SelectItem value="staging">Staging</SelectItem>
							<SelectItem value="production">Production</SelectItem>
						</SelectContent>
					</Select>
				</Field>
				<Field label="Region">
					{provider ? (
						<RegionSelect
							provider={provider}
							value={(c.region as string) ?? ""}
							onChange={(v) => onChange({ region: v })}
						/>
					) : (
						<p className="text-xs text-muted-foreground">
							Select a cloud account first.
						</p>
					)}
				</Field>
			</>
		);
	}

	if (node.data.kind === "network") {
		const provision = c.provision_network !== false;
		return (
			<>
				<div className="flex items-center justify-between">
					<Label className="text-xs">Provision new network</Label>
					<Switch
						checked={provision}
						onCheckedChange={(v) => onChange({ provision_network: v })}
					/>
				</div>
				{provision ? (
					<Field label="CIDR block">
						<Input
							value={(c.cidr_block as string) ?? ""}
							placeholder="10.0.0.0/16"
							className="h-9 font-mono text-sm"
							onChange={(e) => onChange({ cidr_block: e.target.value })}
						/>
					</Field>
				) : (
					<Field label="Existing network ID">
						<Input
							value={(c.network_id as string) ?? ""}
							placeholder="vpc-…"
							className="h-9 font-mono text-sm"
							onChange={(e) => onChange({ network_id: e.target.value })}
						/>
					</Field>
				)}
			</>
		);
	}

	if (node.data.kind === "cluster") {
		if (!provider)
			return <ProviderNotice />;
		const instances = (c.instance_types as string[] | undefined) ?? [];
		return (
			<>
				<Field label="Kubernetes version">
					<Select
						value={(c.cluster_version as string) ?? K8S_VERSIONS[provider][0]}
						onValueChange={(v) => onChange({ cluster_version: v })}
					>
						<SelectTrigger className="h-9 text-sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{K8S_VERSIONS[provider].map((v) => (
								<SelectItem key={v} value={v}>
									{v}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				<Field label="Instance type">
					<Select
						value={instances[0] ?? INSTANCE_TYPES[provider][0].value}
						onValueChange={(v) => onChange({ instance_types: [v] })}
					>
						<SelectTrigger className="h-9 text-sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{INSTANCE_TYPES[provider].map((it) => (
								<SelectItem key={it.value} value={it.value}>
									{it.label} · {it.vcpu}vCPU/{it.memoryGb}GB
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				<div className="grid grid-cols-3 gap-2">
					{(["node_min_size", "node_desired_size", "node_max_size"] as const).map(
						(key, i) => (
							<Field key={key} label={["Min", "Desired", "Max"][i]}>
								<Input
									type="number"
									min={1}
									max={100}
									value={(c[key] as number) ?? 2}
									className="h-9 text-sm"
									onChange={(e) =>
										onChange({ [key]: Number.parseInt(e.target.value, 10) || 0 })
									}
								/>
							</Field>
						),
					)}
				</div>
			</>
		);
	}

	if (node.data.kind === "database") {
		if (!provider) return <ProviderNotice />;
		const capacity = DB_CAPACITY[provider];
		return (
			<>
				<Field label="Name">
					<Input
						value={(c.name as string) ?? ""}
						className="h-9 font-mono text-sm"
						onChange={(e) => onChange({ name: e.target.value.toLowerCase() })}
					/>
				</Field>
				<Field label="Engine">
					<Select
						value={(c.engine as string) ?? DB_ENGINES[provider][0].value}
						onValueChange={(v) => {
							const eng = DB_ENGINES[provider].find((e) => e.value === v);
							onChange({ engine: v, engine_version: eng?.defaultVersion });
						}}
					>
						<SelectTrigger className="h-9 text-sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{DB_ENGINES[provider].map((e) => (
								<SelectItem key={e.value} value={e.value}>
									{e.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				<div className="grid grid-cols-2 gap-2">
					<Field label={`Min ${capacity.unit}`}>
						<Input
							type="number"
							step={capacity.step}
							min={capacity.min}
							max={capacity.max}
							value={(c.min_capacity as number) ?? capacity.defaultMin}
							className="h-9 text-sm"
							onChange={(e) =>
								onChange({ min_capacity: Number.parseFloat(e.target.value) || 0 })
							}
						/>
					</Field>
					<Field label={`Max ${capacity.unit}`}>
						<Input
							type="number"
							step={capacity.step}
							min={capacity.min}
							max={capacity.max}
							value={(c.max_capacity as number) ?? capacity.defaultMax}
							className="h-9 text-sm"
							onChange={(e) =>
								onChange({ max_capacity: Number.parseFloat(e.target.value) || 0 })
							}
						/>
					</Field>
				</div>
				<div className="flex items-center justify-between">
					<Label className="text-xs">IAM authentication</Label>
					<Switch
						checked={!!c.iam_auth}
						onCheckedChange={(v) => onChange({ iam_auth: v })}
					/>
				</div>
			</>
		);
	}

	if (node.data.kind === "cache") {
		if (!provider) return <ProviderNotice />;
		return (
			<>
				<Field label="Name">
					<Input
						value={(c.name as string) ?? ""}
						className="h-9 font-mono text-sm"
						onChange={(e) => onChange({ name: e.target.value.toLowerCase() })}
					/>
				</Field>
				<Field label="Engine">
					<Select
						value={(c.engine as string) ?? "redis"}
						onValueChange={(v) => onChange({ engine: v })}
					>
						<SelectTrigger className="h-9 text-sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="redis">Redis</SelectItem>
							<SelectItem value="valkey">Valkey</SelectItem>
						</SelectContent>
					</Select>
				</Field>
				<Field label="Node type">
					<Select
						value={(c.node_type as string) ?? CACHE_NODE_TYPES[provider][0].value}
						onValueChange={(v) => onChange({ node_type: v })}
					>
						<SelectTrigger className="h-9 text-sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{CACHE_NODE_TYPES[provider].map((n) => (
								<SelectItem key={n.value} value={n.value}>
									{n.label} · {n.memoryGb}GB ({n.cost})
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				<div className="grid grid-cols-2 gap-2">
					<Field label="Nodes">
						<Input
							type="number"
							min={1}
							max={6}
							value={(c.num_cache_nodes as number) ?? 1}
							className="h-9 text-sm"
							onChange={(e) =>
								onChange({ num_cache_nodes: Number.parseInt(e.target.value, 10) || 1 })
							}
						/>
					</Field>
					<div className="flex items-end justify-between pb-1.5">
						<Label className="text-xs">Multi-AZ</Label>
						<Switch
							checked={!!c.multi_az}
							onCheckedChange={(v) => onChange({ multi_az: v })}
						/>
					</div>
				</div>
			</>
		);
	}

	if (node.data.kind === "queue") {
		const messaging = provider ? MESSAGING[provider] : null;
		return (
			<>
				<Field label="Name">
					<Input
						value={(c.name as string) ?? ""}
						className="h-9 font-mono text-sm"
						onChange={(e) => onChange({ name: e.target.value.toLowerCase() })}
					/>
				</Field>
				<Field label={messaging?.visibilityTimeoutLabel ?? "Visibility timeout (s)"}>
					<Input
						type="number"
						min={0}
						max={43200}
						value={(c.visibility_timeout as number) ?? 30}
						className="h-9 text-sm"
						onChange={(e) =>
							onChange({ visibility_timeout: Number.parseInt(e.target.value, 10) || 0 })
						}
					/>
				</Field>
				<div className="flex items-center justify-between">
					<Label className="text-xs">{messaging?.fifoLabel ?? "Ordered delivery"}</Label>
					<Switch
						checked={!!c.ordered}
						onCheckedChange={(v) => onChange({ ordered: v })}
					/>
				</div>
			</>
		);
	}

	if (node.data.kind === "topic") {
		return (
			<Field label="Name">
				<Input
					value={(c.name as string) ?? ""}
					className="h-9 font-mono text-sm"
					onChange={(e) => onChange({ name: e.target.value.toLowerCase() })}
				/>
			</Field>
		);
	}

	if (node.data.kind === "nosql") {
		const nosql = provider ? NOSQL[provider] : null;
		return (
			<>
				<Field label="Name">
					<Input
						value={(c.name as string) ?? ""}
						className="h-9 font-mono text-sm"
						onChange={(e) => onChange({ name: e.target.value.toLowerCase() })}
					/>
				</Field>
				<div className="grid grid-cols-2 gap-2">
					<Field label="Partition key">
						<Input
							value={(c.partition_key as string) ?? ""}
							placeholder="id"
							className="h-9 font-mono text-sm"
							onChange={(e) => onChange({ partition_key: e.target.value })}
						/>
					</Field>
					<Field label="Type">
						<Select
							value={(c.partition_key_type as string) ?? "S"}
							onValueChange={(v) => onChange({ partition_key_type: v })}
						>
							<SelectTrigger className="h-9 text-sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{(nosql?.keyTypes ?? [{ value: "S", label: "String" }]).map((k) => (
									<SelectItem key={k.value} value={k.value}>
										{k.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
				</div>
				<Field label="Capacity mode">
					<Select
						value={(c.capacity_mode as string) ?? "on_demand"}
						onValueChange={(v) => onChange({ capacity_mode: v })}
					>
						<SelectTrigger className="h-9 text-sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{(nosql?.billingModes ?? [{ value: "on_demand", label: "On-demand" }]).map(
								(m) => (
									<SelectItem key={m.value} value={m.value}>
										{m.label}
									</SelectItem>
								),
							)}
						</SelectContent>
					</Select>
				</Field>
				<div className="flex items-center justify-between">
					<Label className="text-xs">Point-in-time recovery</Label>
					<Switch
						checked={c.point_in_time_recovery !== false}
						onCheckedChange={(v) => onChange({ point_in_time_recovery: v })}
					/>
				</div>
			</>
		);
	}

	if (node.data.kind === "secret") {
		return (
			<>
				<Field label="Name">
					<Input
						value={(c.name as string) ?? ""}
						className="h-9 font-mono text-sm"
						onChange={(e) =>
							onChange({ name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })
						}
					/>
				</Field>
				<div className="flex items-center justify-between">
					<Label className="text-xs">Auto-generate</Label>
					<Switch
						checked={c.generate !== false}
						onCheckedChange={(v) => onChange({ generate: v })}
					/>
				</div>
				{c.generate !== false && (
					<>
						<Field label="Length">
							<Input
								type="number"
								min={8}
								max={128}
								value={(c.length as number) ?? 32}
								className="h-9 text-sm"
								onChange={(e) =>
									onChange({ length: Number.parseInt(e.target.value, 10) || 32 })
								}
							/>
						</Field>
						<div className="flex items-center justify-between">
							<Label className="text-xs">Special characters</Label>
							<Switch
								checked={!!c.special_chars}
								onCheckedChange={(v) => onChange({ special_chars: v })}
							/>
						</div>
					</>
				)}
			</>
		);
	}

	if (node.data.kind === "repositories") {
		return (
			<Field label="ArgoCD apps repository">
				<RepositorySelector
					label=""
					placeholder="Select repository"
					value={(c.apps_destination_repo as string) || undefined}
					onChange={(v) => onChange({ apps_destination_repo: v || "" })}
				/>
			</Field>
		);
	}

	// dns
	return (
		<>
			<div className="flex items-center justify-between">
				<Label className="text-xs">Enabled</Label>
				<Switch
					checked={c.enabled !== false}
					onCheckedChange={(v) => onChange({ enabled: v })}
				/>
			</div>
			<Field label="Domain name">
				<Input
					value={(c.domain_name as string) ?? ""}
					placeholder="example.com"
					className="h-9 font-mono text-sm"
					onChange={(e) => onChange({ domain_name: e.target.value })}
				/>
			</Field>
			<div className="flex items-center justify-between">
				<Label className="text-xs">Managed certificate</Label>
				<Switch
					checked={!!c.managed_certificate}
					onCheckedChange={(v) => onChange({ managed_certificate: v })}
				/>
			</div>
			<div className="flex items-center justify-between">
				<Label className="text-xs">WAF</Label>
				<Switch
					checked={!!c.waf_enabled}
					onCheckedChange={(v) => onChange({ waf_enabled: v })}
				/>
			</div>
		</>
	);
}

function ProviderNotice() {
	return (
		<p className="text-xs text-muted-foreground">
			Select a cloud account on the project node first.
		</p>
	);
}
