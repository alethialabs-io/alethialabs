"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getToolName, type ToolUIPart } from "ai";
import type { ReactNode } from "react";
import { ToolResultFrame } from "@/components/agent/tool-result-frame";
import { inAppApprovalOutputSchema, isInAppApprovalToolName } from "@/lib/agent/approval-output";
import { InAppApprovalCard } from "./in-app-approval-card";

/**
 * The transcript render of a `request_apply` / `request_destroy` call, shared by the org and project
 * renderers: the frame's live marker while it runs, then the approval card for a recorded request, or
 * the engine's refusal as one line. Null for any other tool, so a renderer asks this first and falls
 * through.
 */
export function renderApprovalRequestPart(part: ToolUIPart): ReactNode | null {
	if (!isInAppApprovalToolName(getToolName(part))) return null;
	if (part.state !== "output-available") return <ToolResultFrame part={part} title="Approval request" />;
	const parsed = inAppApprovalOutputSchema.safeParse(part.output);
	if (!parsed.success) return <ToolResultFrame part={part} title="Approval request" />;
	const output = parsed.data;
	return (
		<ToolResultFrame part={part} title="Approval request">
			{output.status === "requested" ? (
				<InAppApprovalCard request={output} />
			) : (
				<div className="font-mono text-ui-xs text-muted-foreground">Not requested: {output.reason}</div>
			)}
		</ToolResultFrame>
	);
}
