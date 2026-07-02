"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ChevronDown, Copy, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@repo/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@repo/ui/collapsible";
import { cn } from "@repo/ui/utils";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { NODE_REGISTRY } from "../graph/node-registry";
import type { CanvasNode } from "../graph/types";

/**
 * Collapsed "Danger zone" section at the bottom of the config sheet: destructive / structural
 * actions for the selected resource. Array kinds can be duplicated; deletable kinds can be
 * removed. Hidden entirely for the (non-deletable, singular) project root.
 */
export function DangerZone({ node }: { node: CanvasNode }) {
	const [open, setOpen] = useState(false);
	const removeNodes = useCanvasStore((s) => s.removeNodes);
	const duplicateNodes = useCanvasStore((s) => s.duplicateNodes);

	const isArray = NODE_REGISTRY[node.data.kind].cardinality === "array";
	const deletable = node.deletable !== false;
	if (!isArray && !deletable) return null;

	const label =
		(node.data.config.name as string) || NODE_REGISTRY[node.data.kind].label;

	return (
		<Collapsible
			open={open}
			onOpenChange={setOpen}
			className="rounded-lg border border-destructive/30"
		>
			<CollapsibleTrigger className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
				<span className="flex items-center gap-2">
					<TriangleAlert className="h-4 w-4 text-destructive" />
					<span className="text-sm font-medium text-destructive">
						Danger zone
					</span>
				</span>
				<ChevronDown
					className={cn(
						"h-4 w-4 shrink-0 text-muted-foreground transition-transform",
						open && "rotate-180",
					)}
				/>
			</CollapsibleTrigger>
			<CollapsibleContent className="space-y-3 border-t border-destructive/20 px-4 py-4">
				{isArray && (
					<div className="flex items-center justify-between gap-4">
						<div className="min-w-0">
							<p className="text-sm font-medium">Duplicate resource</p>
							<p className="text-xs text-muted-foreground">
								Create a copy with the same configuration.
							</p>
						</div>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => {
								duplicateNodes([node.id]);
								toast.success(`Duplicated ${label}`);
							}}
						>
							<Copy className="mr-1.5 h-3.5 w-3.5" />
							Duplicate
						</Button>
					</div>
				)}
				{deletable && (
					<div className="flex items-center justify-between gap-4">
						<div className="min-w-0">
							<p className="text-sm font-medium">Delete resource</p>
							<p className="text-xs text-muted-foreground">
								Remove this resource from the canvas. This can be undone with
								⌘Z.
							</p>
						</div>
						<Button
							type="button"
							variant="destructive"
							size="sm"
							onClick={() => {
								removeNodes([node.id]);
								toast.success(`Deleted ${label}`);
							}}
						>
							<Trash2 className="mr-1.5 h-3.5 w-3.5" />
							Delete
						</Button>
					</div>
				)}
			</CollapsibleContent>
		</Collapsible>
	);
}
