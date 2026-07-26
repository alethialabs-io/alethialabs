"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Surface 1 of #1247 — where a project says which private chart repos it pulls Helm charts from.
//
// A chart repo is credential plumbing, not architecture: it provisions nothing and appears in no
// diagram, so it gets the same treatment as the cluster and the network — an env-settings sheet
// rather than a card on the board (see canvas-flow's never-drawn list).
//
// Most rows here are DERIVED, not typed: `useHelmRegistryReconcile` matches the `oci://` hosts the
// project's charts reference against the org's connected chart-repo connectors and adds the pairing
// itself. The list is therefore mostly a review surface — it shows what was inferred, flags the
// hosts we refused to guess at, and lets the user override any of it. Rows persist on deploy, which
// is exactly when the runner needs them to seed the ArgoCD repository-credential Secret.

import { useMemo, useState } from "react";
import { AlertTriangle, Package, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@repo/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@repo/ui/empty";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { Separator } from "@repo/ui/separator";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@repo/ui/sheet";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { ProviderConfigFields } from "@/components/connector/provider-config-fields";
import { useConnectedProviders } from "@/components/design-project/connectors-context";
import {
	duplicateHelmRegistryUrls,
	helmRegistryUrl,
	isSelectableHelmRegistry,
	ociHostOf,
	type UnresolvedChartHost,
} from "@/lib/connectors/helm-registry-derive";
import { getProvidersForCategory } from "@/lib/connectors/registry.generated";
import { orgHref } from "@/lib/routing";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { validateNodeConfig } from "./inspector/node-validation";
import { useHelmRegistryReconcile } from "./use-helm-registry-reconcile";
import type { CanvasNode } from "./graph/types";

/** The chart-repo rows currently on the graph, with their node ids. */
function useChartRepoNodes() {
	const nodes = useCanvasStore((s) => s.nodes);
	return useMemo(
		() => nodes.filter((n): n is CanvasNode<"helm_registry"> => n.data.kind === "helm_registry"),
		[nodes],
	);
}

/** Toolbar button + the sheet. Mirrors EnvSettingsSheet's shape. */
export function ChartReposSheet() {
	const [open, setOpen] = useState(false);
	const rows = useChartRepoNodes();
	const { unresolved } = useHelmRegistryReconcile();
	// One badge for "there is something to look at" — an unresolved host means a chart cannot pull.
	const attention = unresolved.length;

	return (
		<>
			<Button
				type="button"
				size="sm"
				variant="outline"
				className="h-8 text-xs"
				onClick={() => setOpen(true)}
			>
				<Package className="mr-1 h-3.5 w-3.5" />
				Chart repos
				{rows.length > 0 || attention > 0 ? (
					<span
						className={
							attention > 0
								? "ml-1.5 font-mono text-[10px] text-destructive"
								: "ml-1.5 font-mono text-[10px] text-muted-foreground"
						}
					>
						{attention > 0 ? `${attention}!` : rows.length}
					</span>
				) : null}
			</Button>
			<Sheet open={open} onOpenChange={setOpen}>
				<SheetContent className="w-[480px] overflow-y-auto sm:max-w-[480px]">
					<SheetHeader>
						<SheetTitle>Chart repos</SheetTitle>
						<SheetDescription>
							Private Helm repositories this environment pulls charts from. Alethia matches a
							chart&apos;s registry host to a connected chart-repo connector and seeds the ArgoCD
							credential at deploy — pick one here only when the host is ambiguous or unmatched.
						</SheetDescription>
					</SheetHeader>
					<ChartReposBody unresolved={unresolved} />
				</SheetContent>
			</Sheet>
		</>
	);
}

function ChartReposBody({ unresolved }: { unresolved: UnresolvedChartHost[] }) {
	const { org } = useParams<{ org: string }>();
	const rows = useChartRepoNodes();
	const nodes = useCanvasStore((s) => s.nodes);
	const addHelmRegistries = useCanvasStore((s) => s.addHelmRegistries);
	const removeNodes = useCanvasStore((s) => s.removeNodes);
	const connected = useConnectedProviders("helm_registry");

	// Only providers that are both connected AND active — the ECR rows are catalogued but
	// `coming_soon` (12h tokens, no stable stored password), so offering them would promise auth we
	// can't deliver.
	const options = useMemo(
		() => connected.filter((p) => isSelectableHelmRegistry(p.slug)),
		[connected],
	);

	// Which charts each repo actually serves — the answer to "can I delete this?".
	const chartsByHost = useMemo(() => {
		const map = new Map<string, string[]>();
		for (const node of nodes) {
			if (node.data.kind !== "chart") continue;
			const host = ociHostOf(node.data.config.repoUrl);
			if (!host) continue;
			map.set(host, [...(map.get(host) ?? []), node.data.config.id]);
		}
		return map;
	}, [nodes]);

	const duplicates = useMemo(
		() => new Set(duplicateHelmRegistryUrls(rows.map((n) => n.data.config))),
		[rows],
	);

	const connectHref = `${orgHref(org)}/~/connectors`;

	return (
		<div className="mt-5 flex flex-col gap-5 px-1">
			{unresolved.length > 0 ? (
				<section className="flex flex-col gap-2">
					<h3 className="vx-eyebrow flex items-center gap-1.5 text-[10px]">
						<AlertTriangle className="h-3 w-3" />
						Needs a chart repo
					</h3>
					{unresolved.map((item) => (
						<UnresolvedRow
							key={item.host}
							item={item}
							connectHref={connectHref}
							onPick={(slug) =>
								addHelmRegistries([
									{
										name: item.host.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase(),
										provider: slug,
										provider_config: { registry_host: item.host },
									},
								])
							}
						/>
					))}
					<Separator />
				</section>
			) : null}

			<section className="flex flex-col gap-3">
				<div className="flex items-center justify-between">
					<h3 className="vx-eyebrow text-[10px]">Repositories</h3>
					<span className="font-mono text-[10px] text-muted-foreground">{rows.length}</span>
				</div>

				{rows.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<Package />
							</EmptyMedia>
							<EmptyTitle>No private chart repos</EmptyTitle>
							<EmptyDescription>
								Public charts need none. Attach a chart from an <code>oci://</code> registry and
								the repo appears here automatically.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					rows.map((node) => (
						<ChartRepoRow
							key={node.id}
							node={node}
							options={options}
							charts={chartsByHost.get(ociHostOf(helmRegistryUrl(node.data.config)) ?? "") ?? []}
							duplicate={duplicates.has(helmRegistryUrl(node.data.config))}
							onRemove={() => removeNodes([node.id])}
						/>
					))
				)}

				<Button
					type="button"
					variant="outline"
					size="sm"
					className="h-8 text-xs"
					disabled={options.length === 0}
					onClick={() =>
						addHelmRegistries([
							{ name: "charts", provider: options[0]?.slug ?? null, provider_config: {} },
						])
					}
				>
					<Plus className="mr-1 h-3.5 w-3.5" />
					Add a chart repo
				</Button>

				{options.length === 0 ? (
					<p className="text-xs text-muted-foreground">
						No chart-repo connectors are connected.{" "}
						<Link href={connectHref} className="underline underline-offset-2">
							Connect one
						</Link>{" "}
						to pull charts from a private registry.
					</p>
				) : null}
			</section>
		</div>
	);
}

/** A host used by a chart that derivation could not pair with a connector. */
function UnresolvedRow({
	item,
	connectHref,
	onPick,
}: {
	item: UnresolvedChartHost;
	connectHref: string;
	onPick: (slug: string) => void;
}) {
	return (
		<div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/30 p-3">
			<span className="font-mono text-[11px] text-foreground">{item.host}</span>
			{item.reason === "no_connector" ? (
				<p className="text-xs text-muted-foreground">
					A chart pulls from this registry, but no connected chart-repo connector can
					authenticate it.{" "}
					<Link href={connectHref} className="underline underline-offset-2">
						Connect one
					</Link>
					.
				</p>
			) : (
				<>
					<p className="text-xs text-muted-foreground">
						More than one connected connector could serve this host — pick the one that owns it.
					</p>
					<Select value="" onValueChange={onPick}>
						<SelectTrigger className="h-8 text-xs">
							<SelectValue placeholder="Select a connector…" />
						</SelectTrigger>
						<SelectContent>
							{item.candidates.map((slug) => (
								<SelectItem key={slug} value={slug}>
									{providerName(slug)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</>
			)}
		</div>
	);
}

/** One chart-repo selection: which connector, its non-secret knobs, and what it serves. */
function ChartRepoRow({
	node,
	options,
	charts,
	duplicate,
	onRemove,
}: {
	node: CanvasNode<"helm_registry">;
	options: ReturnType<typeof getProvidersForCategory>;
	charts: string[];
	duplicate: boolean;
	onRemove: () => void;
}) {
	const updateNodeConfig = useCanvasStore((s) => s.updateNodeConfig);
	const config = node.data.config;
	const provider = options.find((p) => p.slug === config.provider);
	const url = helmRegistryUrl(config);
	const errors = validateNodeConfig("helm_registry", { ...config });

	return (
		<div className="flex flex-col gap-3 rounded-md border border-border p-3">
			<div className="flex items-start justify-between gap-2">
				<div className="flex min-w-0 items-center gap-2">
					<span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded border border-border">
						<ConnectorIcon src={provider?.icon_url} name={provider?.name ?? "?"} size={16} />
					</span>
					<div className="flex min-w-0 flex-col">
						<span className="truncate text-xs">{provider?.name ?? "Not configured"}</span>
						<span className="truncate font-mono text-[10px] text-muted-foreground">
							{url || "—"}
						</span>
					</div>
				</div>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="h-7 w-7 shrink-0"
					onClick={onRemove}
					aria-label={`Remove ${config.name}`}
				>
					<Trash2 className="h-3.5 w-3.5" />
				</Button>
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`repo-name-${node.id}`}>Name</Label>
				<Input
					id={`repo-name-${node.id}`}
					value={config.name}
					onChange={(e) => updateNodeConfig(node.id, { name: e.target.value })}
					className="h-8 font-mono text-xs"
					aria-invalid={errors.name ? true : undefined}
				/>
				{errors.name ? <p className="text-xs text-destructive">{errors.name}</p> : null}
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`repo-provider-${node.id}`}>Connector</Label>
				<Select
					value={config.provider ?? ""}
					onValueChange={(slug) =>
						// Knobs are per-provider, so a provider change must not carry the old one's config
						// (a stale registry_host would silently build the wrong credential URL).
						updateNodeConfig(node.id, { provider: slug, provider_config: {} })
					}
				>
					<SelectTrigger id={`repo-provider-${node.id}`} className="h-8 text-xs">
						<SelectValue placeholder="Select a connector…" />
					</SelectTrigger>
					<SelectContent>
						{options.map((option) => (
							<SelectItem key={option.slug} value={option.slug}>
								{option.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{errors.provider ? (
					<p className="text-xs text-destructive">{errors.provider}</p>
				) : null}
			</div>

			{provider ? (
				<ProviderConfigFields
					fields={provider.providerConfigFields}
					values={{ ...config.provider_config }}
					onChange={(key, value) =>
						updateNodeConfig(node.id, {
							provider_config: { ...config.provider_config, [key]: value },
						})
					}
					errors={
						errors.provider_config
							? Object.fromEntries(
									provider.providerConfigFields
										.filter((f) => f.required)
										.map((f) => [f.key, errors.provider_config]),
								)
							: undefined
					}
					idPrefix={`repo-cfg-${node.id}`}
				/>
			) : null}

			{duplicate ? (
				<p className="text-xs text-destructive">
					Another repo resolves to the same URL. The credential is named from the URL, so only one
					of them will be seeded.
				</p>
			) : null}

			<p className="font-mono text-[10px] text-muted-foreground">
				{charts.length > 0
					? `pulls ${charts.length} chart${charts.length === 1 ? "" : "s"} · ${charts.join(", ")}`
					: "no chart references this repo yet"}
			</p>
		</div>
	);
}

/** Catalog display name for a slug (the unresolved picker has no provider object to hand). */
function providerName(slug: string): string {
	return getProvidersForCategory("helm_registry").find((p) => p.slug === slug)?.name ?? slug;
}
