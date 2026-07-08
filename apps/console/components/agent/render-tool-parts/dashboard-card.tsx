"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ToolUIPart } from "ai";
import { LayoutDashboard } from "lucide-react";
import { AgentToolCard } from "@/components/agent/agent-chat";
import { dashboardSpecSchema } from "@/lib/ai/tools/visualize";
import { track } from "@/lib/analytics/track";
import type { Artifact, ArtifactTab } from "@/lib/stores/use-artifact-store";
import { Button } from "@repo/ui/button";

/**
 * The `build_dashboard` tool-result lane, shared by the org + project surfaces: it
 * parses the emitted spec (falling back to the default tool card on a malformed one)
 * and offers an "Open dashboard" action that opens the grayscale dashboard in the
 * artifact split pane and records the `elench_dashboard_built` analytics event.
 */
export function DashboardReadyCard({
	part,
	openArtifact,
	context,
}: {
	part: ToolUIPart;
	openArtifact: (artifact: Artifact, tab: ArtifactTab) => void;
	context: "org" | "project";
}) {
	const parsed = dashboardSpecSchema.safeParse(part.output);
	if (!parsed.success) return <AgentToolCard part={part} />;
	const spec = parsed.data;
	return (
		<div className="flex items-center justify-between gap-2 border border-border px-3 py-2.5">
			<div className="min-w-0">
				<div className="truncate text-[13px] font-medium text-foreground">
					Dashboard ready
				</div>
				<div className="truncate text-xs text-muted-foreground">{spec.title}</div>
			</div>
			<Button
				variant="outline"
				size="sm"
				className="flex-none gap-1.5 rounded-none"
				onClick={() => {
					openArtifact({ dashboard: spec }, "dashboard");
					track("elench_dashboard_built", { context });
				}}
			>
				<LayoutDashboard className="h-3.5 w-3.5" />
				Open dashboard
			</Button>
		</div>
	);
}
