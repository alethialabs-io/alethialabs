// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getEmailConfig } from "@/lib/config/email";
import { sendEmail } from "@/lib/email/send";
import { ContactLeadEmail, subject as contactSubject } from "@/emails/contact-lead";
import { SALES_MAIL, type ContactLeadInput } from "@/lib/validations/contact.schema";

/** The lead fields we notify on — the validated submission minus bot/control fields. */
type ContactLead = Omit<ContactLeadInput, "honeypot">;

/**
 * Notifies the sales inbox of a new contact-form submission. Routes to
 * {@link SALES_MAIL} on the product/general sending stream. When SES is
 * unconfigured (local/dev) `sendEmail` logs instead of sending, so the contact
 * form works end-to-end with zero email setup.
 */
export async function sendContactLeadEmail(lead: ContactLead): Promise<void> {
	await sendEmail({
		from: getEmailConfig().from.general,
		to: SALES_MAIL,
		subject: contactSubject(lead.type, lead.name || lead.email),
		react: ContactLeadEmail({
			type: lead.type,
			name: lead.name,
			email: lead.email,
			phone: lead.phone,
			country: lead.country,
			website: lead.website,
			companySize: lead.companySize,
			interest: lead.interest,
			message: lead.message,
		}),
		devLog: `${lead.type} lead from ${lead.email}`,
	});
}
