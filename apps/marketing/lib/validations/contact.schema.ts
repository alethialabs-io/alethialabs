// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { isValidPhoneNumber } from "libphonenumber-js";
import { z } from "zod";

/**
 * Contact-lead form schema — the single source of truth for both the client
 * form (react-hook-form via zodResolver) and the public server action that
 * receives the submission. One form serves every "talk to us" path on the site;
 * the `topic` field says which conversation the sender wants, and drives the
 * inbox subject line.
 */

/** Sales inbox the form routes to (also surfaced in the success state). */
export const SALES_MAIL = "sales@alethialabs.io";

/** Default country selection (ISO 3166-1 alpha-2) — matches the phone default. */
export const DEFAULT_COUNTRY = "BG";

/** Company-size buckets. */
export const SIZES = [
	"1–10",
	"11–50",
	"51–200",
	"201–500",
	"501–1,000",
	"1,000+",
] as const;

/** Primary product-interest options. */
export const INTERESTS = [
	"Enterprise governance",
	"Console — control plane",
	"alethia CLI",
	"Runners & jobs",
	"AI agent & MCP",
	"Self-managed deployment",
	"Something else",
] as const;

/**
 * What the sender wants to talk about. The order is the order the form shows.
 *
 * This replaced a `type: "sales" | "enterprise"` discriminator that only said
 * which of two pages the form sat on. There is one contact page now, and the
 * inbox needs to know the conversation, not the URL.
 */
export const CONTACT_TOPICS = ["demo", "enterprise", "services", "other"] as const;

export type ContactTopic = (typeof CONTACT_TOPICS)[number];

/** Human label for each topic — the form's option text and the lead email's subject prefix. */
export const CONTACT_TOPIC_LABELS: Record<ContactTopic, string> = {
	demo: "Product demo",
	enterprise: "Enterprise trial",
	services: "Services project",
	other: "Something else",
};

/** The topic a contact page opens on when nothing selects one. */
export const DEFAULT_CONTACT_TOPIC: ContactTopic = "demo";

/** The topics that are about the product, so the form asks about team size and product interest. */
const PRODUCT_TOPICS: readonly ContactTopic[] = ["demo", "enterprise"];

/** The topics that ask for a company size: the product ones plus a services project. */
const SIZED_TOPICS: readonly ContactTopic[] = ["demo", "enterprise", "services"];

/** Whether the form shows (and the schema requires) the product-interest field for this topic. */
export function topicAsksInterest(topic: ContactTopic): boolean {
	return PRODUCT_TOPICS.includes(topic);
}

/** Whether the form shows (and the schema requires) the company-size field for this topic. */
export function topicAsksSize(topic: ContactTopic): boolean {
	return SIZED_TOPICS.includes(topic);
}

/**
 * Reads a `?topic=` value into a known topic. Anything unrecognised — a typo, an
 * old link, a repeated parameter — falls back to `fallback` rather than erroring,
 * because a contact page that refuses to render over a query string loses the lead.
 */
export function parseContactTopic(
	value: string | string[] | undefined,
	fallback: ContactTopic = DEFAULT_CONTACT_TOPIC,
): ContactTopic {
	const raw = Array.isArray(value) ? value[0] : value;
	const match = CONTACT_TOPICS.find((topic) => topic === raw);
	return match ?? fallback;
}

/**
 * Validated shape of a contact-lead submission. `honeypot` is a hidden field
 * left empty by humans; the server action treats a filled value as a bot and
 * silently no-ops rather than surfacing a validation error.
 *
 * `companySize` and `interest` are optional at the field level and required by
 * the refinement below only for the topics that show them — a services enquiry
 * has no "primary product interest", and "Something else" asks for neither.
 */
export const contactLeadSchema = z
	.object({
		topic: z.enum(CONTACT_TOPICS, { error: "Choose what this is about." }),
		email: z.email("Enter a valid company email."),
		name: z.string().trim().min(1, "Tell us your name."),
		// Company location — ISO 3166-1 alpha-2 code (e.g. "BG").
		country: z.string().min(1, "Select a country."),
		// Optional phone, stored E.164; validated per-country when present.
		phone: z
			.string()
			.refine((v) => !v || isValidPhoneNumber(v), "Enter a valid phone number.")
			.optional(),
		website: z
			.url("Enter a valid URL (https://…).")
			.or(z.literal(""))
			.optional(),
		companySize: z.enum(SIZES).optional(),
		interest: z.enum(INTERESTS).optional(),
		message: z.string().trim().max(5000).optional(),
		/**
		 * Acknowledgement that the enquiry is used ONLY to reply — not consent to marketing.
		 *
		 * The field kept its name so nothing downstream had to change, but its meaning did: it used to
		 * back "I agree to receive communications … withdraw via the unsubscribe link", which promised a
		 * mailing list that does not exist and a withdrawal route that was never built (#2371). There is
		 * no marketing basis here to consent to; the lawful basis for replying to an enquiry somebody
		 * sent is legitimate interests, and the acknowledgement is what makes that legible.
		 */
		consent: z
			.boolean()
			.refine((v) => v === true, "Please acknowledge to continue."),
		honeypot: z.string().optional(),
	})
	.superRefine((lead, ctx) => {
		if (topicAsksSize(lead.topic) && !lead.companySize) {
			ctx.addIssue({ code: "custom", path: ["companySize"], message: "Select a company size." });
		}
		if (topicAsksInterest(lead.topic) && !lead.interest) {
			ctx.addIssue({ code: "custom", path: ["interest"], message: "Select a product interest." });
		}
	});

export type ContactLeadInput = z.infer<typeof contactLeadSchema>;
