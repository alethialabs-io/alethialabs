// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The in-product agent's approval tools as data: their names, the operation each requests, and the
// output the model receives and the approval card renders from. Shared client + server, so it imports
// nothing but zod and types (lib/approvals/types.ts reaches the database).

import { z } from "zod";
import type { ApplyOperation, ApprovalStatus } from "@/lib/approvals/types";

/** The tool that requests each operation, and the operation each tool requests. */
const IN_APP_APPROVAL_TOOLS = {
	request_apply: "deploy",
	request_destroy: "destroy",
} as const satisfies Record<string, ApplyOperation>;

/** One of the keys of {@link IN_APP_APPROVAL_TOOLS}. */
export type InAppApprovalToolName = keyof typeof IN_APP_APPROVAL_TOOLS;

/** Narrows a tool name to an {@link InAppApprovalToolName}. */
export function isInAppApprovalToolName(name: string): name is InAppApprovalToolName {
	return Object.hasOwn(IN_APP_APPROVAL_TOOLS, name);
}

/** The approval states, as lib/approvals/types.ts lists them (held equal by the type check below). */
const APPROVAL_STATUS_VALUES = ["pending", "approved", "rejected", "expired", "superseded", "consumed"] as const;

/** The two operations, as lib/approvals/types.ts lists them. */
const OPERATION_VALUES = ["deploy", "destroy"] as const;

/** Compile-time: the local lists name exactly the engine's values, in both directions. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const statusesMatch: Same<(typeof APPROVAL_STATUS_VALUES)[number], ApprovalStatus> = true;
const operationsMatch: Same<(typeof OPERATION_VALUES)[number], ApplyOperation> = true;
void statusesMatch;
void operationsMatch;

/**
 * What `request_apply` / `request_destroy` return to the model, and what the approval card renders
 * from. `requested` carries the approval as the approvals API shows it; `refused` carries the engine's
 * own sentence for the model to relay.
 */
export const inAppApprovalOutputSchema = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("requested"),
		approval_id: z.uuid(),
		approval_status: z.enum(APPROVAL_STATUS_VALUES),
		operation: z.enum(OPERATION_VALUES),
		project_id: z.uuid(),
		environment_id: z.uuid(),
		plan_job_id: z.uuid(),
		digest_prefix: z.string(),
		expires_at: z.string(),
	}),
	z.object({
		status: z.literal("refused"),
		code: z.string(),
		reason: z.string(),
	}),
]);

/** One output of the in-product agent's approval tools. */
export type InAppApprovalOutput = z.infer<typeof inAppApprovalOutputSchema>;
