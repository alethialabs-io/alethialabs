"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The inline docked side panel shared by the project shell (persistent, across all project views)
// and the standalone create-flow canvas. It shows the node inspector OR the AI assistant (never
// both). The assistant is kept mounted (hidden when inactive) so its chat survives closing /
// switching; the parent decides which is active via `useDockState`.

import { motion } from "motion/react";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import { AssistantPanel } from "@/components/project-assistant/project-assistant";
import { useAssistantStore } from "@/lib/stores/use-assistant-store";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { cn } from "@repo/ui/utils";
import { InspectorPanel } from "./node-inspector";

/** Docked panel geometry: the bordered panel width + the gap between it and the canvas. */
export const PANEL_W = 400;
export const PANEL_GAP = 12;

export type DockContent = "inspector" | "assistant" | null;

/**
 * Which panel the dock should show. `inspectorAllowed` gates the (canvas-only) inspector — false on
 * non-Architecture views. The assistant needs a real project (the create flow has none).
 */
export function useDockState(
	inspectorAllowed: boolean,
	hasProject: boolean,
): DockContent {
	const inspectorNodeId = useCanvasStore((s) => s.inspectorNodeId);
	const assistantOpen = useAssistantStore((s) => s.open);
	return inspectorAllowed && inspectorNodeId
		? "inspector"
		: assistantOpen && hasProject
			? "assistant"
			: null;
}

/** The bordered, width-animated dock. Width → 0 when closed; the assistant stays mounted. */
export function CanvasDock({
	dock,
	projectId,
	identities,
	onDestroyEnvironment,
}: {
	dock: DockContent;
	projectId?: string;
	identities: CloudIdentityOption[];
	onDestroyEnvironment?: () => void;
}) {
	return (
		<motion.div
			initial={false}
			animate={{ width: dock ? PANEL_W + PANEL_GAP : 0 }}
			transition={{ duration: 0.2, ease: "easeOut" }}
			className="h-full shrink-0 overflow-hidden"
		>
			<div className="h-full pl-3" style={{ width: PANEL_W + PANEL_GAP }}>
				<div
					className="flex h-full flex-col overflow-hidden rounded-lg border border-border bg-background"
					style={{ width: PANEL_W }}
				>
					{dock === "inspector" && (
						<InspectorPanel
							identities={identities}
							onDestroyEnvironment={onDestroyEnvironment}
						/>
					)}
					{/* Kept mounted (just hidden) to preserve the agent conversation. */}
					<div
						className={cn(
							"flex h-full min-h-0 flex-col",
							dock !== "assistant" && "hidden",
						)}
					>
						{projectId && <AssistantPanel projectId={projectId} />}
					</div>
				</div>
			</div>
		</motion.div>
	);
}
