// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { isValidPhoneNumber } from "libphonenumber-js";
import { z } from "zod";

/**
 * Contact-lead form schema — the single source of truth for both the client
 * form (react-hook-form via zodResolver) and the public server action that
 * receives the submission. Mirrors the fields in the Alethia Labs site design
 * (Talk to sales / Enterprise trial); both pages post the same shape, only the
 * `type` discriminator and rail copy differ.
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

/** Which page the lead came from — drives copy, subject line, and routing. */
export const contactLeadTypes = ["sales", "enterprise"] as const;

/**
 * Validated shape of a contact-lead submission. `honeypot` is a hidden field
 * left empty by humans; the server action treats a filled value as a bot and
 * silently no-ops rather than surfacing a validation error.
 */
export const contactLeadSchema = z.object({
	type: z.enum(contactLeadTypes),
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
	companySize: z.enum(SIZES, { error: "Select a company size." }),
	interest: z.enum(INTERESTS, { error: "Select a product interest." }),
	message: z.string().trim().max(5000).optional(),
	consent: z
		.boolean()
		.refine((v) => v === true, "Please accept to continue."),
	honeypot: z.string().optional(),
});

export type ContactLeadInput = z.infer<typeof contactLeadSchema>;
export type ContactLeadType = (typeof contactLeadTypes)[number];
