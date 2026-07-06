// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Out-of-band staff notification for support cases. Staff answer cases from Slack, so a
// new case / customer reply pings a webhook. It is a no-op when SUPPORT_SLACK_WEBHOOK_URL
// is unset (the default OSS self-host), and never throws — a notify failure must never
// fail the customer's submit/reply.

/** A rendered Slack notification for a support-case event. */
export interface SlackNotifyPayload {
	/** The message text (also the notification fallback). */
	text: string;
	caseNumber: number;
	subject: string;
	severity: string;
	orgId?: string;
	/** Deep link back to the case in the console. */
	url?: string;
}

/**
 * Renders a case notification's Slack Block Kit body from the payload. A short header
 * line plus a context line (case number · severity · org) and a link button when a URL
 * is present.
 */
function blocksFor(payload: SlackNotifyPayload): unknown[] {
	const context = [
		`CASE-${String(payload.caseNumber).padStart(6, "0")}`,
		`severity: ${payload.severity}`,
		payload.orgId ? `org: ${payload.orgId}` : undefined,
	]
		.filter(Boolean)
		.join("  ·  ");

	const blocks: unknown[] = [
		{
			type: "section",
			text: { type: "mrkdwn", text: `*${payload.text}*\n${payload.subject}` },
		},
		{
			type: "context",
			elements: [{ type: "mrkdwn", text: context }],
		},
	];

	if (payload.url) {
		blocks.push({
			type: "actions",
			elements: [
				{
					type: "button",
					text: { type: "plain_text", text: "Open case" },
					url: payload.url,
				},
			],
		});
	}

	return blocks;
}

/**
 * Posts a support-case notification to the configured Slack webhook. No-ops when the
 * webhook env var is unset (OSS self-host), and swallows every error so a failed notify
 * never surfaces to the customer.
 */
export async function notifySupportSlack(
	payload: SlackNotifyPayload,
): Promise<void> {
	const webhook = process.env.SUPPORT_SLACK_WEBHOOK_URL;
	if (!webhook) return;

	try {
		await fetch(webhook, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				text: payload.text,
				blocks: blocksFor(payload),
			}),
		});
	} catch (err) {
		console.warn("[support] Slack notify failed:", err);
	}
}

/** Formats + sends the "new case" Slack notification. */
export async function slackCaseCreated(args: {
	caseNumber: number;
	subject: string;
	severity: string;
	orgId?: string;
	url?: string;
}): Promise<void> {
	await notifySupportSlack({
		text: "New support case",
		caseNumber: args.caseNumber,
		subject: args.subject,
		severity: args.severity,
		orgId: args.orgId,
		url: args.url,
	});
}

/** Formats + sends the "customer replied" Slack notification. */
export async function slackCaseReplied(args: {
	caseNumber: number;
	subject: string;
	severity: string;
	orgId?: string;
	url?: string;
}): Promise<void> {
	await notifySupportSlack({
		text: "Customer replied to a case",
		caseNumber: args.caseNumber,
		subject: args.subject,
		severity: args.severity,
		orgId: args.orgId,
		url: args.url,
	});
}
