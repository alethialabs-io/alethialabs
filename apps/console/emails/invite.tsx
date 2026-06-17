// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	Button,
	Column,
	Heading,
	Link,
	Row,
	Section,
	Text,
} from "@react-email/components";
import { EmailLayout } from "./components/layout";
import { footerLegalLink } from "./components/footer";
import { colors, fonts, primaryButton, radii, text } from "./components/theme";

export const subject = (inviterName: string) =>
	`${inviterName} invited you to a vineyard on Alethia`;

interface InviteEmailProps {
	inviterName?: string;
	inviterInitials?: string;
	vineyardName?: string;
	role?: string;
	acceptUrl?: string;
	expiresInDays?: number;
}

/** Team flow — invitation to collaborate on a vineyard. */
export function InviteEmail({
	inviterName = "Dana Okafor",
	inviterInitials = "DO",
	vineyardName = "platform-core",
	role = "Maintainer",
	acceptUrl = "https://console.alethialabs.io/invites/accept?token=vyd_9f31a0",
	expiresInDays = 7,
}: InviteEmailProps) {
	return (
		<EmailLayout
			preview={`${inviterName} invited you to the ${vineyardName} vineyard on Alethia.`}
			legal={
				<>
					This invite was sent to you by a member of {vineyardName}.
					Questions?{" "}
					<Link
						href="mailto:support@alethialabs.io"
						style={footerLegalLink}
					>
						support@alethialabs.io
					</Link>{" "}
					·{" "}
					<Link href="https://alethialabs.io/privacy" style={footerLegalLink}>
						Privacy
					</Link>{" "}
					·{" "}
					<Link href="https://alethialabs.io/terms" style={footerLegalLink}>
						Terms
					</Link>
				</>
			}
		>
			<Text style={text.eyebrow}>Invitation</Text>
			<Heading as="h2" style={text.heading}>
				You&apos;ve been invited to a vineyard.
			</Heading>
			<Text style={text.body}>
				<strong style={{ color: colors.textPrimary, fontWeight: 500 }}>
					{inviterName}
				</strong>{" "}
				invited you to collaborate on the{" "}
				<strong style={{ color: colors.textPrimary, fontWeight: 500 }}>
					{vineyardName}
				</strong>{" "}
				vineyard — a shared workspace for provisioning and managing
				infrastructure on Alethia.
			</Text>

			<Section
				style={{
					border: `1px solid ${colors.border}`,
					borderRadius: radii.md,
					backgroundColor: colors.surfaceSunken,
					padding: "18px 20px",
					margin: "4px 0 24px",
				}}
			>
				<Row>
					<Column style={{ width: "44px", verticalAlign: "middle" }}>
						<Section
							style={{
								width: "44px",
								height: "44px",
								borderRadius: radii.full,
								border: `1px solid ${colors.borderStrong}`,
								backgroundColor: colors.surfaceMuted,
								textAlign: "center",
							}}
						>
							<Text
								style={{
									fontFamily: fonts.mono,
									fontSize: "14px",
									letterSpacing: "0.04em",
									color: colors.textPrimary,
									lineHeight: "44px",
									margin: 0,
								}}
							>
								{inviterInitials}
							</Text>
						</Section>
					</Column>
					<Column style={{ paddingLeft: "16px", verticalAlign: "middle" }}>
						<Text
							style={{
								fontFamily: fonts.sans,
								fontSize: "14px",
								fontWeight: 500,
								color: colors.textPrimary,
								margin: "0 0 3px",
							}}
						>
							{inviterName}
						</Text>
						<Text
							style={{
								fontFamily: fonts.mono,
								fontSize: "11px",
								letterSpacing: "0.04em",
								color: colors.textTertiary,
								margin: 0,
							}}
						>
							{vineyardName} · role: {role}
						</Text>
					</Column>
				</Row>
			</Section>

			<Button href={acceptUrl} style={primaryButton}>
				Accept invitation →
			</Button>

			<Text
				style={{
					...text.body,
					fontSize: "13px",
					color: colors.textTertiary,
					margin: "20px 0 0",
				}}
			>
				This invitation expires in {expiresInDays} days. If you weren&apos;t
				expecting it, you can ignore this email.
			</Text>
		</EmailLayout>
	);
}

InviteEmail.PreviewProps = {
	inviterName: "Dana Okafor",
	inviterInitials: "DO",
	vineyardName: "platform-core",
	role: "Maintainer",
	acceptUrl: "https://console.alethialabs.io/invites/accept?token=vyd_9f31a0",
	expiresInDays: 7,
} satisfies InviteEmailProps;

export default InviteEmail;
