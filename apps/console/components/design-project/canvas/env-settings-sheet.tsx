"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Settings2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@repo/ui/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@repo/ui/sheet";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";
import { ConfigFields } from "./inspector/config-fields";
import { getKindConfig } from "./inspector/config-schema";

/**
 * W2 — the cluster + network are no longer cards on the board (one environment IS one cluster inside
 * one VPC). They stay env-scoped DB singletons, edited here as environment settings. The rows persist
 * as hidden store nodes, so this edits them through the SAME `updateNodeConfig` + `CONFIG_SCHEMA`
 * the inspector used — graphToForm / the deploy snapshot are unchanged.
 */
export function EnvSettingsSheet() {
	const [open, setOpen] = useState(false);
	const nodes = useCanvasStore((s) => s.nodes);
	const updateNodeConfig = useCanvasStore((s) => s.updateNodeConfig);
	const provider = useCanvasStore((s) => s.getEffectiveProvider(PROJECT_NODE_ID));

	const cluster = nodes.find((n) => n.data.kind === "cluster");
	const network = nodes.find((n) => n.data.kind === "network");
	const clusterSchema = getKindConfig("cluster");
	const networkSchema = getKindConfig("network");

	return (
		<>
			<Button
				type="button"
				size="sm"
				variant="outline"
				className="h-8 text-xs"
				onClick={() => setOpen(true)}
			>
				<Settings2 className="mr-1 h-3.5 w-3.5" />
				Cluster &amp; network
			</Button>
			<Sheet open={open} onOpenChange={setOpen}>
				<SheetContent className="w-[440px] overflow-y-auto sm:max-w-[440px]">
					<SheetHeader>
						<SheetTitle>Cluster &amp; network</SheetTitle>
						<SheetDescription>
							This environment&apos;s Kubernetes cluster and its VPC. One environment is one
							cluster — everything on the board deploys into it. Configure it here; it isn&apos;t a
							card.
						</SheetDescription>
					</SheetHeader>
					<div className="mt-5 space-y-6 px-1">
						{cluster && clusterSchema && (
							<section className="space-y-2">
								<h3 className="vx-eyebrow text-[10px]">Cluster</h3>
								<ConfigFields
									schema={clusterSchema}
									config={cluster.data.config}
									provider={provider}
									kind="cluster"
									onChange={(patch) => updateNodeConfig(cluster.id, patch)}
								/>
							</section>
						)}
						{network && networkSchema && (
							<section className="space-y-2">
								<h3 className="vx-eyebrow text-[10px]">Network (VPC)</h3>
								<ConfigFields
									schema={networkSchema}
									config={network.data.config}
									provider={provider}
									kind="network"
									onChange={(patch) => updateNodeConfig(network.id, patch)}
								/>
							</section>
						)}
					</div>
				</SheetContent>
			</Sheet>
		</>
	);
}
