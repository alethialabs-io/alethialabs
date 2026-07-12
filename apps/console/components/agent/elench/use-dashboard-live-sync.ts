"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { isToolUIPart, type ToolUIPart, type UIMessage } from "ai";
import { useEffect, useRef } from "react";
import { z } from "zod";
import { dashboardSpecSchema } from "@/lib/ai/tools/visualize";
import { useArtifactStore } from "@/lib/stores/use-artifact-store";

/** Loose parse of a build_dashboard input that is still streaming (fields arrive late). */
const partialSpecSchema = z.object({
	title: z.string().optional(),
	blocks: z.array(z.unknown()).optional(),
});

/** The newest build_dashboard tool part in the transcript, scanning backwards. */
function newestDashboardPart(messages: UIMessage[]): ToolUIPart | null {
	for (let m = messages.length - 1; m >= 0; m--) {
		const parts = messages[m]?.parts ?? [];
		for (let p = parts.length - 1; p >= 0; p--) {
			const part = parts[p];
			if (part && isToolUIPart(part) && part.type === "tool-build_dashboard")
				return part;
		}
	}
	return null;
}

/**
 * Streams `build_dashboard` results into an awaiting artifact panel, so the pane fills
 * the moment the tool finishes instead of waiting for the "Open dashboard" click. It
 * only ever writes when the current artifact is a dashboard that is pending
 * (`dashboard === null`) or owned by the same tool call — a closed panel is never
 * reopened (the transcript card stays the explicit affordance) and a dashboard the user
 * opened from a different result is never clobbered. While the tool input streams, it
 * surfaces progress (title + block count) for the pending pane's building state.
 */
export function useDashboardLiveSync(messages: UIMessage[]): void {
	// Tool calls whose finished spec was already written — the effect runs per messages
	// change, so without this a settled transcript would re-write (and re-maximize) forever.
	const syncedRef = useRef<Set<string>>(new Set());

	useEffect(() => {
		const part = newestDashboardPart(messages);
		if (!part) return;

		const { artifact, open } = useArtifactStore.getState();
		// Only an awaiting dashboard panel is ours to update: pending (dashboard === null)
		// or opened from this same call. A closed panel / project/job artifact stays put.
		const awaiting =
			artifact?.dashboard === null ||
			(artifact?.dashboard !== undefined &&
				artifact.dashboardSourceId === part.toolCallId);
		if (!awaiting) return;

		if (part.state === "output-available") {
			if (syncedRef.current.has(part.toolCallId)) return;
			const parsed = dashboardSpecSchema.safeParse(part.output);
			if (!parsed.success) return;
			syncedRef.current.add(part.toolCallId);
			open(
				{ dashboard: parsed.data, dashboardSourceId: part.toolCallId },
				"dashboard",
			);
			return;
		}

		// Still composing: surface streamed progress on the pending pane (only when it
		// actually advanced, to avoid store thrash on every token).
		if (part.state === "input-streaming" && artifact?.dashboard === null) {
			const partial = partialSpecSchema.safeParse(part.input);
			if (!partial.success) return;
			const next = {
				title: partial.data.title,
				blocks: partial.data.blocks?.length ?? 0,
			};
			const prev = artifact.dashboardProgress;
			if (prev?.title === next.title && prev?.blocks === next.blocks) return;
			useArtifactStore.setState({
				artifact: { ...artifact, dashboardProgress: next },
			});
		}
	}, [messages]);
}
