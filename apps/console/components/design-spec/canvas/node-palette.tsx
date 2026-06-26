"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import { Button } from "@repo/ui/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@repo/ui/sheet";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { ADDABLE_KINDS, NODE_REGISTRY } from "./graph/node-registry";
import type { NodeKind } from "./graph/types";

interface NodePaletteProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	identities: CloudIdentityOption[];
}

/** Left Sheet to choose and add a component to the canvas. */
export function NodePalette({ open, onOpenChange, identities }: NodePaletteProps) {
	const addNode = useCanvasStore((s) => s.addNode);
	const nodes = useCanvasStore((s) => s.nodes);

	const add = (kind: NodeKind) => {
		addNode(kind);
		onOpenChange(false);
	};

	const groups: { title: string; kinds: NodeKind[] }[] = [
		{
			title: "Core",
			kinds: ADDABLE_KINDS.filter(
				(k) => NODE_REGISTRY[k].classification === "core",
			),
		},
		{
			title: "Periphery",
			kinds: ADDABLE_KINDS.filter(
				(k) => NODE_REGISTRY[k].classification === "periphery",
			),
		},
	];

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="left" className="w-[320px] gap-0 sm:max-w-[320px]">
				<SheetHeader>
					<span className="vx-eyebrow">Add</span>
					<SheetTitle className="text-base">Components</SheetTitle>
					<SheetDescription className="text-xs">
						Drop a resource onto the canvas. Core resources run on the stack
						cloud; periphery can sit on any connected vendor.
					</SheetDescription>
				</SheetHeader>

				{identities.length === 0 ? (
					<div className="space-y-3 px-4">
						<p className="text-sm text-muted-foreground">
							Connect a cloud account to start composing.
						</p>
						<Link href="/dashboard/connectors">
							<Button variant="outline" size="sm" className="h-8 text-xs">
								Connect
							</Button>
						</Link>
					</div>
				) : (
					<div className="space-y-5 px-4 pb-10">
						{groups.map((g) => (
							<div key={g.title} className="space-y-2">
								<span className="vx-eyebrow">{g.title}</span>
								<div className="grid gap-2">
									{g.kinds.map((kind) => {
										const def = NODE_REGISTRY[kind];
										const Icon = def.icon;
										const isSingleton = nodes.some((n) => n.data.kind === kind);
										return (
											<button
												key={kind}
												type="button"
												onClick={() => add(kind)}
												className="flex items-center gap-3 border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent"
											>
												<Icon className="h-4 w-4 text-muted-foreground" />
												<div className="min-w-0 flex-1">
													<div className="text-sm font-medium">{def.label}</div>
												</div>
												{isSingleton && def.cardinality === "singleton" && (
													<span className="font-mono text-[10px] text-muted-foreground">
														on canvas
													</span>
												)}
											</button>
										);
									})}
								</div>
							</div>
						))}
					</div>
				)}
			</SheetContent>
		</Sheet>
	);
}
