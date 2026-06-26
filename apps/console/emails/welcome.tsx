// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button, Heading, Link, Section, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { footerLegalLink } from "@repo/email/components/footer";
import { colors, fonts, primaryButton, radii, text } from "@repo/email/components/theme";

export const subject = "Welcome to Alethia — your control plane is ready";

interface WelcomeEmailProps {
	consoleUrl?: string;
}

const STEPS = [
	{
		n: "01",
		title: "Create a Spec.",
		body: "Open the console and walk the guided sections into your first cluster.",
	},
	{
		n: "02",
		title: "Install the CLI.",
		body: "Plan, deploy, and destroy from the terminal — brew install alethia.",
	},
	{
		n: "03",
		title: "Read the docs.",
		body: "Architecture, the Zones & Specs model, and provider setup for AWS, GCP, and Azure.",
	},
] as const;

/** Post-signup welcome / onboarding email. */
export function WelcomeEmail({
	consoleUrl = "https://alethialabs.io",
}: WelcomeEmailProps) {
	return (
		<EmailLayout
			preview="Your Alethia control plane is ready — design your first spec."
			legal={
				<>
					You&apos;re receiving this because you created an Alethia
					account. Manage{" "}
					<Link
						href="https://alethialabs.io/settings/notifications"
						className="a-text-2"
						style={footerLegalLink}
					>
						email preferences
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
				Welcome
			</Text>
			<Heading as="h2" className="a-text" style={text.heading}>
				Your control plane is ready.
			</Heading>
			<Text className="a-text-2" style={text.body}>
				Configure multi-cloud Kubernetes visually. Deploy from the
				terminal. Zero credentials stored. Everything you provision
				compiles into a single Terraform plan you can review before it
				runs.
			</Text>
			<Text className="a-text-2" style={{ ...text.body, marginBottom: "22px" }}>
				Sign in to the console to design your first spec, or pick up the
				CLI:
			</Text>

			<Section
				className="a-sunken a-border a-text-2"
				style={{
					fontFamily: fonts.mono,
					fontSize: "13px",
					backgroundColor: colors.surfaceSunken,
					border: `1px solid ${colors.border}`,
					borderRadius: radii.md,
					padding: "13px 16px",
					color: colors.textSecondary,
					margin: "4px 0 22px",
				}}
			>
				<span className="a-text-3" style={{ color: colors.textTertiary }}>
					$
				</span>{" "}
				alethia login
			</Section>

			<Section style={{ margin: "4px 0 26px" }}>
				{STEPS.map((step, i) => (
					<Section
						key={step.n}
						className="a-border"
						style={{
							padding: "14px 0",
							borderTop: `1px solid ${colors.border}`,
							borderBottom:
								i === STEPS.length - 1
									? `1px solid ${colors.border}`
									: undefined,
						}}
					>
						<span
							className="a-text-3"
							style={{
								fontFamily: fonts.mono,
								fontSize: "11px",
								letterSpacing: "0.1em",
								color: colors.textTertiary,
								marginRight: "14px",
								verticalAlign: "top",
							}}
						>
							{step.n}
						</span>
						<span
							className="a-text-2"
							style={{
								fontFamily: fonts.sans,
								fontSize: "13.5px",
								lineHeight: "1.5",
								color: colors.textSecondary,
							}}
						>
							<strong
								className="a-text"
								style={{ color: colors.textPrimary, fontWeight: 500 }}
							>
								{step.title}
							</strong>{" "}
							{step.body}
						</span>
					</Section>
				))}
			</Section>

			<Button href={consoleUrl} className="a-btn" style={primaryButton}>
				Open the console →
			</Button>
		</EmailLayout>
	);
}

WelcomeEmail.PreviewProps = {
	consoleUrl: "https://alethialabs.io",
} satisfies WelcomeEmailProps;

export default WelcomeEmail;
