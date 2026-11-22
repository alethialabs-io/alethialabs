// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { text } from "@repo/email/components/theme";

/** The subject line, e.g. "The Acme team on Alethia was deleted". */
export function subject(orgName: string): string {
	return `The ${orgName} team on Alethia was deleted`;
}

export interface OrganizationDeletedEmailProps {
	/** The deleted organization's name. */
	orgName: string;
	/** Whether a paid subscription was cancelled with it. */
	subscriptionCancelled: boolean;
}

/** Tells a member that a team they belonged to was deleted by its owner. */
export function OrganizationDeletedEmail({
	orgName,
	subscriptionCancelled,
}: OrganizationDeletedEmailProps) {
	return (
		<EmailLayout
			preview={subject(orgName)}
			legal="You receive this because you were a member of this team on Alethia."
		>
			<Text className="a-text-3" style={text.eyebrow}>
				Team deleted
			</Text>
			<Heading as="h2" className="a-text" style={text.heading}>
				{orgName} was deleted.
			</Heading>
			<Text className="a-text-2" style={text.body}>
				An owner of <strong>{orgName}</strong> deleted the team. Its projects and settings are gone,
				and your access to it ended with it. Your own Alethia account and your other teams are not
				affected.
			</Text>
			{subscriptionCancelled ? (
				<Text className="a-text-2" style={text.body}>
					The team&apos;s paid subscription was cancelled at the same time, so it will not be charged
					again.
				</Text>
			) : null}
		</EmailLayout>
	);
}

OrganizationDeletedEmail.PreviewProps = {
	orgName: "Acme Cloud",
	subscriptionCancelled: true,
} satisfies OrganizationDeletedEmailProps;

export default OrganizationDeletedEmail;
