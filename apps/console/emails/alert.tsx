// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button, Heading, Section, Text } from "@react-email/components";
import type { AlertEventContext } from "@/types/jsonb.types";
import { EmailLayout } from "@repo/email/components/layout";
import { colors, fonts, primaryButton, radii, text } from "@repo/email/components/theme";

export const subject = "Alethia alert";

interface AlertEmailProps {
	/** The rendered event payload captured at emit time. */
	context: AlertEventContext;
	/** Human label for the event type, e.g. "Deploy failed". */
	eventLabel: string;
}

/** A single field row in the detail block. */
function Detail({ label, value }: { label: string; value?: string }) {
	if (!value) return null;
	return (
		<Text
			style={{
				...text.body,
				margin: "0 0 6px",
				fontFamily: fonts.mono,
				fontSize: "12.5px",
				color: colors.textSecondary,
			}}
		>
			<span style={{ color: colors.textTertiary }}>{label}: </span>
			{value}
		</Text>
	);
}

/** Alert notification email — fired by an alert rule via the email channel. */
export function AlertEmail({ context, eventLabel }: AlertEmailProps) {
	const severity = (context.severity ?? "warning").toUpperCase();
	return (
		<EmailLayout
			preview={context.title}
			legal={`You receive this because an Alethia alert rule routes ${eventLabel} to this address.`}
		>
			<Text style={text.eyebrow}>
				{severity} · {eventLabel}
			</Text>
			<Heading style={text.heading}>{context.title}</Heading>
			{context.summary ? (
				<Text style={text.body}>{context.summary}</Text>
			) : null}

			<Section
				style={{
					backgroundColor: colors.surfaceSunken,
					border: `1px solid ${colors.border}`,
					borderRadius: radii.md,
					padding: "16px 18px",
					margin: "8px 0 24px",
				}}
			>
				<Detail label="actor" value={context.actor_id} />
				<Detail label="action" value={context.action} />
				<Detail
					label="resource"
					value={
						context.resource_type
							? `${context.resource_type}${context.resource_id ? ` ${context.resource_id}` : ""}`
							: undefined
					}
				/>
				<Detail label="reason" value={context.reason} />
				<Detail label="job" value={context.job_id} />
				<Detail label="job_type" value={context.job_type} />
				<Detail label="project" value={context.project_id} />
				<Detail label="connector" value={context.connector_slug} />
			</Section>

			{context.link ? (
				<Button href={context.link} style={primaryButton}>
					Open in console
				</Button>
			) : null}
		</EmailLayout>
	);
}

export default AlertEmail;
