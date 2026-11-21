// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button, Heading, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { primaryButton, text } from "@repo/email/components/theme";

export const subject = "Your Alethia data export is ready";

export interface DataExportReadyEmailProps {
	/** The case reference for the export. */
	reference: string;
	/** The download link. Works for the signed-in account only, until `expiresLabel`. */
	downloadUrl: string;
	/** When the link stops working, already formatted. */
	expiresLabel: string;
}

/** Tells the account holder their data export is ready, with a short-lived download link. */
export function DataExportReadyEmail({
	reference,
	downloadUrl,
	expiresLabel,
}: DataExportReadyEmailProps) {
	return (
		<EmailLayout
			preview="Your Alethia data export is ready to download."
			legal="You receive this because you asked for a copy of your data from your Alethia account settings."
		>
			<Text className="a-text-3" style={text.eyebrow}>
				Data export · {reference}
			</Text>
			<Heading as="h2" className="a-text" style={text.heading}>
				Your data export is ready.
			</Heading>
			<Text className="a-text-2" style={text.body}>
				The archive is a JSON file with the personal data your account holds and a signed manifest
				that lists every part and its checksum. The link works only while you are signed in to the
				account that asked for it, and it stops working on <strong>{expiresLabel}</strong>.
			</Text>
			<Button href={downloadUrl} className="a-btn" style={primaryButton}>
				Download my data →
			</Button>
		</EmailLayout>
	);
}

DataExportReadyEmail.PreviewProps = {
	reference: "DSR-1A2B3C4D",
	downloadUrl: "https://alethialabs.io/api/privacy/export/DSR-1A2B3C4D?t=example",
	expiresLabel: "24 Nov 2026",
} satisfies DataExportReadyEmailProps;

export default DataExportReadyEmail;
