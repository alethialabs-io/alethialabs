"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ArrowLeft, ArrowRight } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { NODE_REGISTRY } from "../graph/node-registry";
import { configName } from "../graph/node-config";
import { getKindConfig, type KindConfig } from "./config-schema";
import { ConfigFields } from "./config-fields";

/**
 * The portable slice of a kind's config: its non-`advanced` sections, forced open. These are the
 * cloud-indifferent essentials shown inline in the palette; the provider-specific Advanced knobs stay
 * behind "Full settings →" so the quick step never leaves cloud-indifferent ground.
 */
function essentialsSchema(schema: KindConfig): KindConfig {
	return {
		...schema,
		sections: schema.sections
			.filter((s) => s.tier !== "advanced")
			.map((s) => ({ ...s, defaultOpen: true })),
	};
}

interface NodeQuickConfigProps {
	/** The node just added, being configured inline. */
	nodeId: string;
	/** Return to the service list — keeps the palette open. */
	onBack: () => void;
	/** Hand off to the full docked inspector (opens it, closes the palette). */
	onFullSettings: () => void;
	/** Finish here — close the palette. */
	onDone: () => void;
}

/**
 * W5 — the inline config step inside the Add-service palette. After a service is added the palette
 * stays open and swaps to this view: a breadcrumb back to the list, the node's name, and its
 * essentials fields (validated inline, reusing the inspector's `ConfigFields`). "Full settings →"
 * hands off to the docked inspector for the advanced/provider-specific knobs. Adding and configuring
 * are one uninterrupted flow — the palette never closes underneath you.
 */
export function NodeQuickConfig({
	nodeId,
	onBack,
	onFullSettings,
	onDone,
}: NodeQuickConfigProps) {
	const node = useCanvasStore((s) => s.nodes.find((n) => n.id === nodeId));
	const updateNodeConfig = useCanvasStore((s) => s.updateNodeConfig);
	const getEffectiveProvider = useCanvasStore((s) => s.getEffectiveProvider);

	const def = node ? NODE_REGISTRY[node.data.kind] : null;
	const schema = node ? getKindConfig(node.data.kind) : undefined;
	const essentials = useMemo(
		() => (schema ? essentialsSchema(schema) : undefined),
		[schema],
	);

	if (!node || !def) return null;

	const provider = getEffectiveProvider(node.id);
	const Icon = def.icon;
	// Array kinds carry an editable display name; singletons don't (their identity is the kind).
	const nameKey = def.cardinality === "array" ? "name" : null;

	return (
		<div className="flex max-h-[60vh] flex-col">
			<button
				type="button"
				onClick={onBack}
				className="flex items-center gap-1.5 border-b border-border px-3 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
			>
				<ArrowLeft className="h-3.5 w-3.5 shrink-0" />
				<span>Add a service</span>
				<span className="text-muted-foreground/50">/</span>
				<Icon className="h-3.5 w-3.5 shrink-0" />
				<span className="font-medium text-foreground">{def.label}</span>
			</button>

			<div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
				{nameKey && (
					<div className="space-y-1.5">
						<Label htmlFor="quick-config-name" className="text-xs">
							Name
						</Label>
						<Input
							id="quick-config-name"
							autoFocus
							value={configName(node.data) ?? ""}
							placeholder="name"
							className="h-9 font-mono text-sm"
							onChange={(e) =>
								updateNodeConfig(node.id, {
									[nameKey]: e.target.value.toLowerCase(),
								})
							}
						/>
					</div>
				)}
				{essentials && (
					<ConfigFields
						schema={essentials}
						config={node.data.config}
						provider={provider}
						kind={node.data.kind}
						onChange={(patch) => updateNodeConfig(node.id, patch)}
					/>
				)}
			</div>

			<div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2.5">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="gap-1.5"
					onClick={onFullSettings}
				>
					Full settings
					<ArrowRight className="h-3.5 w-3.5" />
				</Button>
				<Button type="button" size="sm" onClick={onDone}>
					Done
				</Button>
			</div>
		</div>
	);
}
