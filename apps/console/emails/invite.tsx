// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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
import { EmailLayout } from "@repo/email/components/layout";
import { footerLegalLink } from "@repo/email/components/footer";
import { colors, fonts, primaryButton, radii, text } from "@repo/email/components/theme";

export const subject = (inviterName: string) =>
	`${inviterName} invited you to a workspace on Alethia`;

interface InviteEmailProps {
	inviterName?: string;
	inviterInitials?: string;
	workspaceName?: string;
	role?: string;
	acceptUrl?: string;
	expiresInDays?: number;
}

/** Team flow — invitation to collaborate in a workspace (organization). */
export function InviteEmail({
	inviterName = "Dana Okafor",
	inviterInitials = "DO",
	workspaceName = "platform-core",
	role = "Maintainer",
	acceptUrl = "https://alethialabs.io/invites/accept?token=inv_9f31a0",
	expiresInDays = 7,
}: InviteEmailProps) {
	return (
		<EmailLayout
			preview={`${inviterName} invited you to the ${workspaceName} workspace on Alethia.`}
			legal={
				<>
					This invite was sent to you by a member of {workspaceName}.
					Questions?{" "}
					<Link
						href="mailto:support@alethialabs.io"
						className="a-text-2"
						style={footerLegalLink}
					>
						support@alethialabs.io
					</Link>{" "}
					·{" "}
					<Link
						href="https://alethialabs.io/privacy"
						className="a-text-2"
						style={footerLegalLink}
					>
						Privacy
					</Link>{" "}
					·{" "}
					<Link
						href="https://alethialabs.io/terms"
						className="a-text-2"
						style={footerLegalLink}
					>
						Terms
					</Link>
				</>
			}
		>
			<Text className="a-text-3" style={text.eyebrow}>
				Invitation
			</Text>
			<Heading as="h2" className="a-text" style={text.heading}>
				You&apos;ve been invited to a workspace.
			</Heading>
			<Text className="a-text-2" style={text.body}>
				<strong
					className="a-text"
					style={{ color: colors.textPrimary, fontWeight: 500 }}
				>
					{inviterName}
				</strong>{" "}
				invited you to collaborate on the{" "}
				<strong
					className="a-text"
					style={{ color: colors.textPrimary, fontWeight: 500 }}
				>
					{workspaceName}
				</strong>{" "}
				workspace — a shared space for provisioning and managing
				infrastructure on Alethia.
			</Text>

			<Section
				className="a-sunken a-border"
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
							className="a-muted a-border-strong"
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
								className="a-text"
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
							className="a-text"
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
							className="a-text-3"
							style={{
								fontFamily: fonts.mono,
								fontSize: "11px",
								letterSpacing: "0.04em",
								color: colors.textTertiary,
								margin: 0,
							}}
						>
							{workspaceName} · role: {role}
						</Text>
					</Column>
				</Row>
			</Section>

			<Button href={acceptUrl} className="a-btn" style={primaryButton}>
				Accept invitation →
			</Button>

			<Text
				className="a-text-3"
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
	workspaceName: "platform-core",
	role: "Maintainer",
	acceptUrl: "https://alethialabs.io/invites/accept?token=inv_9f31a0",
	expiresInDays: 7,
} satisfies InviteEmailProps;

export default InviteEmail;
