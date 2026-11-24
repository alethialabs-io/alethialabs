// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The sink behind the MCP `send_feedback` tool. Feedback is a message to the vendor, so it goes where
// the console's feedback widget sends it (app/server/actions/feedback.ts): an email to the team inbox
// on the hosted service. A self-managed deployment has no vendor inbox, so the tool answers
// `received: false` there and sends nothing. The email names the organisation, the person and the
// OAuth client by id; it carries no address and nothing from the account but the text itself.

import "server-only";
import { Section, Text } from "@react-email/components";
import { getEmailConfig } from "@repo/email/config";
import { EmailLayout } from "@repo/email/components/layout";
import { text as textStyles } from "@repo/email/components/theme";
import { sendEmail } from "@repo/email/send";
import { env } from "next-runtime-env";
import type { Actor } from "@/lib/authz/types";
import { deploymentMode } from "@/lib/billing/config";

/** The inbox agent feedback is delivered to; the same one the console's widget uses. */
const DEFAULT_FEEDBACK_EMAIL = "feedback@alethialabs.io";

/** What a connected agent reported. */
export interface FeedbackSubmission {
	text: string;
	/** The thing it needed and could not do, when it named one. */
	missingCapability: string | null;
}

/** Who sent the feedback, by id only. */
interface FeedbackOrigin {
	orgId: string;
	userId: string;
	clientId: string | null;
}

/** The internal email one agent feedback submission is delivered as. */
export function AgentFeedbackEmail({
	submission,
	origin,
}: {
	submission: FeedbackSubmission;
	origin: FeedbackOrigin;
}) {
	return (
		<EmailLayout
			preview="Feedback from a connected agent"
			legal="Internal: a connected agent sent feedback through the Alethia MCP server."
		>
			<Text style={textStyles.eyebrow}>Agent feedback</Text>
			{submission.missingCapability ? (
				<Text style={textStyles.body}>Missing: {submission.missingCapability}</Text>
			) : null}
			<Section>
				<Text style={{ ...textStyles.body, whiteSpace: "pre-wrap" }}>{submission.text}</Text>
			</Section>
			<Text style={textStyles.body}>
				org {origin.orgId} · user {origin.userId} · client {origin.clientId ?? "none"}
			</Text>
		</EmailLayout>
	);
}

/**
 * Sends `submission` to the team inbox and returns true, or returns false without sending on a
 * self-managed deployment. With email unconfigured (local, dev) `sendEmail` logs instead.
 */
export async function sendAgentFeedback(actor: Actor, submission: FeedbackSubmission): Promise<boolean> {
	if (deploymentMode() !== "hosted") return false;
	const origin: FeedbackOrigin = {
		orgId: actor.orgId,
		userId: actor.userId,
		clientId: actor.credential === "agent_oauth" ? (actor.credentialRef ?? null) : null,
	};
	await sendEmail({
		from: getEmailConfig().from.general,
		to: env("FEEDBACK_EMAIL") || DEFAULT_FEEDBACK_EMAIL,
		subject: "Agent feedback",
		react: <AgentFeedbackEmail submission={submission} origin={origin} />,
		devLog: `agent feedback from org ${origin.orgId}`,
	});
	return true;
}
