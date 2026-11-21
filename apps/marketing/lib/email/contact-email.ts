// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getEmailConfig } from "@repo/email/config";
import { sendEmail } from "@repo/email/send";
import { ContactLeadEmail, contactLeadSubject, leadCompany } from "@/emails/contact-lead";
import { SALES_MAIL, type ContactLeadInput } from "@/lib/validations/contact.schema";

/** The lead fields we notify on — the validated submission minus bot/control fields. */
type ContactLead = Omit<ContactLeadInput, "honeypot">;

/**
 * Notifies the sales inbox of a new contact-form submission. Routes to
 * {@link SALES_MAIL} on the product/general sending stream, whatever the topic —
 * the subject line carries the topic so the inbox can sort on it. There is no
 * autoreply to the sender: a confirmation sent to whatever address a public form
 * was given is backscatter, and the success card already says what happens next. When SES is
 * unconfigured (local/dev) `sendEmail` logs instead of sending, so the contact
 * form works end-to-end with zero email setup.
 */
export async function sendContactLeadEmail(lead: ContactLead): Promise<void> {
	const config = getEmailConfig();
	await sendEmail({
		from: config.from.general,
		configurationSetName: config.configSet.general,
		to: SALES_MAIL,
		subject: contactLeadSubject(lead.topic, lead.name, leadCompany(lead.website)),
		react: ContactLeadEmail({
			topic: lead.topic,
			name: lead.name,
			email: lead.email,
			phone: lead.phone,
			country: lead.country,
			website: lead.website,
			companySize: lead.companySize,
			interest: lead.interest,
			message: lead.message,
		}),
		devLog: `${lead.topic} contact request; personal details omitted from logs`,
	});
}
