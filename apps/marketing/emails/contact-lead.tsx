// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Column, Heading, Link, Row, Section, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { footerLegalLink } from "@repo/email/components/footer";
import { colors, fonts, radii, text } from "@repo/email/components/theme";
import { countryName } from "@repo/ui/countries";

/** Inbox subject for a new lead — type + who it's from. */
export const subject = (type: "sales" | "enterprise", who: string) =>
	`New ${type} lead — ${who}`;

export interface ContactLeadEmailProps {
	type?: "sales" | "enterprise";
	name?: string;
	email?: string;
	phone?: string;
	/** ISO 3166-1 alpha-2 company country code (e.g. "US"). */
	country?: string;
	website?: string;
	companySize?: string;
	interest?: string;
	message?: string;
}

/** One label/value line in the lead summary, omitted when the value is empty. */
function DetailRow({ label, value }: { label: string; value?: string }) {
	if (!value) return null;
	return (
		<Row style={{ marginBottom: "10px" }}>
			<Column style={{ width: "140px", verticalAlign: "top" }}>
				<Text
					className="a-text-3"
					style={{
						fontFamily: fonts.mono,
						fontSize: "11px",
						letterSpacing: "0.06em",
						textTransform: "uppercase",
						color: colors.textTertiary,
						margin: 0,
					}}
				>
					{label}
				</Text>
			</Column>
			<Column style={{ verticalAlign: "top" }}>
				<Text
					className="a-text"
					style={{
						fontFamily: fonts.sans,
						fontSize: "14px",
						color: colors.textPrimary,
						margin: 0,
						lineHeight: "1.5",
					}}
				>
					{value}
				</Text>
			</Column>
		</Row>
	);
}

/**
 * Internal notification sent to the sales inbox when someone submits the
 * Talk-to-sales / Enterprise-trial form. Summarizes the submission and links
 * back to the lead so a human can follow up.
 */
export function ContactLeadEmail({
	type = "sales",
	name = "Jordan Rivera",
	email = "jordan@acme.com",
	phone,
	country,
	website,
	companySize = "51–200",
	interest = "Enterprise governance",
	message,
}: ContactLeadEmailProps) {
	return (
		<EmailLayout
			preview={`New ${type} lead from ${name} (${email}).`}
			legal={
				<>
					Sent by the alethialabs.io contact form. Reply directly to{" "}
					<Link
						href={`mailto:${email}`}
						className="a-text-2"
						style={footerLegalLink}
					>
						{email}
					</Link>{" "}
					to reach this lead.
				</>
			}
		>
			<Text className="a-text-3" style={text.eyebrow}>
				{type === "enterprise" ? "Enterprise · Trial" : "Contact · Sales"}
			</Text>
			<Heading as="h2" className="a-text" style={text.heading}>
				New {type} lead.
			</Heading>
			<Text className="a-text-2" style={text.body}>
				<strong
					className="a-text"
					style={{ color: colors.textPrimary, fontWeight: 500 }}
				>
					{name}
				</strong>{" "}
				submitted the {type === "enterprise" ? "Enterprise trial" : "sales"}{" "}
				form. Details below.
			</Text>

			<Section
				className="a-sunken a-border"
				style={{
					border: `1px solid ${colors.border}`,
					borderRadius: radii.md,
					backgroundColor: colors.surfaceSunken,
					padding: "20px 22px",
					margin: "4px 0 24px",
				}}
			>
				<DetailRow label="Name" value={name} />
				<DetailRow label="Email" value={email} />
				<DetailRow label="Country" value={countryName(country)} />
				<DetailRow label="Phone" value={phone} />
				<DetailRow label="Website" value={website} />
				<DetailRow label="Company size" value={companySize} />
				<DetailRow label="Interest" value={interest} />
				<DetailRow label="Message" value={message} />
			</Section>
		</EmailLayout>
	);
}

ContactLeadEmail.PreviewProps = {
	type: "sales",
	name: "Jordan Rivera",
	email: "jordan@acme.com",
	phone: "+15550142000",
	country: "US",
	website: "https://acme.com",
	companySize: "201–500",
	interest: "Enterprise governance",
	message: "We run EKS across three accounts and need SSO + audit export.",
} satisfies ContactLeadEmailProps;

export default ContactLeadEmail;
