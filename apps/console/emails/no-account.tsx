// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button, Heading, Link, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { footerLegalLink } from "@repo/email/components/footer";
import { colors, primaryButton, text } from "@repo/email/components/theme";

export const subject = "No Alethia account for this email";

interface NoAccountEmailProps {
	email?: string;
	signupUrl?: string;
}

/**
 * Sent when someone requests a sign-in code for an address that has no account —
 * we never create one silently. Points them to sign up instead.
 */
export function NoAccountEmail({
	email = "you@example.com",
	signupUrl = "https://alethialabs.io/signup",
}: NoAccountEmailProps) {
	return (
		<EmailLayout
			preview="We couldn't find an Alethia account for this email."
			legal={
				<>
					Sent by Alethia Labs because a sign-in to Alethia was requested with
					this address. Questions?{" "}
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
				No account found
			</Text>
			<Heading as="h2" className="a-text" style={text.heading}>
				There&apos;s no account for this email
			</Heading>
			<Text className="a-text-2" style={text.body}>
				Someone tried to sign in to Alethia with{" "}
				<span style={{ color: colors.textPrimary, fontWeight: 500 }}>
					{email}
				</span>
				, but we couldn&apos;t find an account for it. Create one to get
				started — it&apos;s free, no card required.
			</Text>

			<Button href={signupUrl} style={primaryButton}>
				Create your account →
			</Button>

			<Text
				className="a-text-3"
				style={{
					...text.body,
					fontSize: "13px",
					color: colors.textTertiary,
					margin: "22px 0 0",
				}}
			>
				Didn&apos;t try to sign in? You can safely ignore this email — no
				account exists for this address and nothing was created.
			</Text>
		</EmailLayout>
	);
}

NoAccountEmail.PreviewProps = {
	email: "you@example.com",
	signupUrl: "https://alethialabs.io/signup",
} satisfies NoAccountEmailProps;

export default NoAccountEmail;
