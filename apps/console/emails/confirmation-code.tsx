// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading, Link, Section, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { footerLegalLink } from "@repo/email/components/footer";
import { colors, fonts, radii, text } from "@repo/email/components/theme";

export const subject = "Your Alethia verification code";

interface ConfirmationCodeEmailProps {
	code?: string;
	expiryMinutes?: number;
}

/** Sign-in verification code (replaces the magic link). */
export function ConfirmationCodeEmail({
	code = "418902",
	expiryMinutes = 10,
}: ConfirmationCodeEmailProps) {
	const grouped =
		code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;

	return (
		<EmailLayout
			preview={`Your Alethia verification code: ${code}`}
			legal={
				<>
					Sent by Alethia Labs because a sign-in to Alethia was requested
					with this address. Questions?{" "}
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
				Verify your email
			</Text>
			<Heading as="h2" className="a-text" style={text.heading}>
				Confirm your email address
			</Heading>
			<Text className="a-text-2" style={text.body}>
				Enter this code to finish signing in to Alethia. Codes are
				single-use and tied to this request.
			</Text>

			<Section
				className="a-sunken a-border-strong"
				style={{
					margin: "4px 0 22px",
					border: `1px solid ${colors.borderStrong}`,
					borderRadius: radii.md,
					backgroundColor: colors.surfaceSunken,
					padding: "26px 24px",
					textAlign: "center",
				}}
			>
				<Text
					className="a-text"
					style={{
						fontFamily: fonts.mono,
						fontSize: "38px",
						fontWeight: 500,
						letterSpacing: "0.22em",
						color: colors.textPrimary,
						margin: 0,
					}}
				>
					{grouped}
				</Text>
				<Text
					className="a-text-3"
					style={{
						fontFamily: fonts.mono,
						fontSize: "11px",
						letterSpacing: "0.08em",
						color: colors.textTertiary,
						margin: "14px 0 0",
					}}
				>
					Expires in {expiryMinutes} minutes
				</Text>
			</Section>

			<Text
				className="a-text-3"
				style={{
					...text.body,
					fontSize: "13px",
					color: colors.textTertiary,
					margin: 0,
				}}
			>
				Didn&apos;t request this? You can safely ignore this email — no one
				can sign in without the code, and nothing was changed on your
				account.
			</Text>
		</EmailLayout>
	);
}

ConfirmationCodeEmail.PreviewProps = {
	code: "418902",
	expiryMinutes: 10,
} satisfies ConfirmationCodeEmailProps;

export default ConfirmationCodeEmail;
