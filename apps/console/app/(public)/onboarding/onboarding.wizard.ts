// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Post-signup onboarding, declared for the wizard engine (`lib/wizard/`) as ONE step (WIZ-W6, #6929).
//
// One screen: the plan, the organization's name (slug behind a disclosure), the payer facts a Pro
// trial needs — each one DEDUCED and shown as an editable default — and the terms box. What the
// engine gives it:
//   - a tab draft of the name, the slug and the plan, so a reload or Back keeps what was typed;
//   - a server refusal under the field it names (name, slug, country, role, the terms box), and one
//     that names no field shown above the button instead of in a toast.
//
// What it does NOT take from the engine, on purpose: the irreversible gate's `settle()`. Where the
// setup stands is decided by the page, on the server, before this form renders at all
// (`resolveOnboarding` in `lib/auth/onboarding.ts`): a finished setup redirects, an unconfirmed
// payment or an unreadable state renders a card with no form. The submit action asks the same
// question again before it writes, so a stale tab cannot start a second trial.
//
// What the draft never keeps: the terms box (an acceptance restored ticked is an acceptance nobody
// gave), the payer facts (they are re-deduced on every load), the role, and the VAT-number answer and
// state (#7324) — payer facts too.
// `tests/lib/wizard/definitions.test.ts` holds this file to the engine's rules.

import type { FieldPath } from "react-hook-form";
import { orgSlugShapeRefusal } from "@repo/org-slug";
import { z } from "zod";
import { EU_MEMBER_STATES } from "@repo/legal/commerce";
import { isUsStateCode } from "@/lib/billing/tax-ids";
import { finishSlugDraft } from "@/lib/utils/slugify";
import { defineWizard } from "@/lib/wizard/define";

/** The plans a new organization can start on: Hobby (`community`) or the Pro trial (`team`). */
export const ONBOARDING_PLANS = ["community", "team"] as const;

/** The sentence under an unticked terms box when the server has not said which documents it covers. */
export const TERMS_REQUIRED_FALLBACK = "Tick the box to accept the Terms of Service.";

/** The form's values as typed. */
export interface OnboardingValues {
	plan: (typeof ONBOARDING_PLANS)[number];
	name: string;
	/** The URL slug as typed: a draft that may end in a hyphen until it is finished. */
	slug: string;
	/** ISO 3166-1 alpha-2, or "" when nothing could be deduced. Read only on the Pro trial. */
	billingCountry: string;
	/** The one payer-capacity switch: on is a purchase for an organization. Read only on the Pro trial. */
	business: boolean;
	/** The payer's role at the organization — the attestation a business purchase needs. */
	role: string;
	/**
	 * Whether the business has a VAT number (#7324): "" until answered — never defaulted. Asked only of
	 * a business billed in an EU member state, where the answer decides which sale is possible.
	 */
	vatIdStatus: "" | "given" | "not_given";
	/** The VAT number, when the business has one. */
	vatId: string;
	/** USPS state code for a US payer; "" until chosen. */
	billingState: string;
	/** The inline terms box. Starts unticked, always. */
	acceptTerms: boolean;
	/** Whether the server says the current terms are not yet accepted. Set by the page, never typed. */
	termsRequired: boolean;
}

/** The submit contract, with the rules that span fields. */
export const onboardingSchema = z
	.object({
		plan: z.enum(ONBOARDING_PLANS),
		name: z.string().trim().min(2, "Give your organization a name.").max(200),
		slug: z.string().max(200),
		billingCountry: z.string(),
		business: z.boolean(),
		role: z.string().max(200, "Keep your role under 200 characters."),
		vatIdStatus: z.enum(["", "given", "not_given"]),
		vatId: z.string().max(32, "Keep the VAT number under 32 characters."),
		billingState: z.string().max(2),
		acceptTerms: z.boolean(),
		termsRequired: z.boolean(),
	})
	.superRefine((values, ctx) => {
		const slugProblem = orgSlugShapeRefusal(finishSlugDraft(values.slug));
		if (slugProblem) ctx.addIssue({ code: "custom", path: ["slug"], message: slugProblem.message });
		if (values.termsRequired && !values.acceptTerms) {
			ctx.addIssue({ code: "custom", path: ["acceptTerms"], message: TERMS_REQUIRED_FALLBACK });
		}
		if (values.plan !== "team") return;
		if (values.billingCountry.trim().length !== 2) {
			ctx.addIssue({
				code: "custom",
				path: ["billingCountry"],
				message: "Select the country this organization is billed in.",
			});
		}
		if (values.business && values.role.trim().length < 2) {
			ctx.addIssue({
				code: "custom",
				path: ["role"],
				message: "Say what your role is — a purchase for a company needs someone who can act for it.",
			});
		}
		const country = values.billingCountry.trim().toUpperCase();
		if (values.business && EU_MEMBER_STATES.includes(country)) {
			if (values.vatIdStatus === "") {
				ctx.addIssue({
					code: "custom",
					path: ["vatIdStatus"],
					message: "Say whether the organization has a VAT number.",
				});
			}
			if (values.vatIdStatus === "given" && values.vatId.trim().length === 0) {
				ctx.addIssue({ code: "custom", path: ["vatId"], message: "Enter the VAT number." });
			}
		}
		if (country === "US" && !isUsStateCode(values.billingState)) {
			ctx.addIssue({
				code: "custom",
				path: ["billingState"],
				message: "Select the US state this organization is billed in.",
			});
		}
	});

/** The values once the submit schema has parsed them. */
export type OnboardingOutput = z.output<typeof onboardingSchema>;

/** The fields the one step owns, in the order they appear. `termsRequired` is owned but never shown. */
export const ONBOARDING_FIELDS: readonly FieldPath<OnboardingValues>[] = [
	"plan",
	"name",
	"slug",
	"billingCountry",
	"business",
	"role",
	"vatIdStatus",
	"vatId",
	"billingState",
	"acceptTerms",
	"termsRequired",
];

/** Onboarding as a one-step wizard: its submit contract, its step and its tab draft. */
export const onboardingWizard = defineWizard<OnboardingValues, OnboardingOutput>({
	id: "onboarding",
	presentation: "page",
	schema: onboardingSchema,
	steps: [
		{
			id: "organization",
			label: "Organization",
			fields: ONBOARDING_FIELDS,
			schema: onboardingSchema,
		},
	],
	draft: {
		version: 1,
		ttlMinutes: 24 * 60,
		schema: z.object({
			plan: z.enum(ONBOARDING_PLANS).optional(),
			name: z.string().optional(),
			slug: z.string().optional(),
		}),
	},
});
