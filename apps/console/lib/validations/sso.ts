// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/**
 * The SSO provider editor form. Deliberately FLAT (not a discriminated union) so the accordion's
 * per-section field paths stay simple, with conditional validation in `superRefine` — only the
 * ACTIVE protocol's fields are required, so switching OIDC↔SAML mid-edit never validates the
 * hidden branch's fields.
 *
 * Secrets (`clientSecret`, `cert`) are required only when CREATING. On edit they're optional: the
 * stored value is preserved (the update merges into the existing config), so we never round-trip a
 * secret to the browser just to save it back.
 */
const base = z.object({
	type: z.enum(["oidc", "saml"]),
	providerId: z
		.string()
		.trim()
		.min(1, "Give the provider an id")
		.max(64)
		.regex(/^[a-z0-9-]+$/, "Lowercase letters, numbers and dashes only"),
	domain: z
		.string()
		.trim()
		.min(1, "The email domain your IdP asserts for")
		.regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, "Must be a domain, e.g. acme.com"),
	issuer: z.string().trim().min(1, "Required"),
	clientId: z.string().trim().optional(),
	clientSecret: z.string().trim().optional(),
	entryPoint: z.string().trim().optional(),
	cert: z.string().trim().optional(),
	/** IdP claim → user field. Empty strings are dropped before saving. */
	mappingEmail: z.string().trim().optional(),
	mappingName: z.string().trim().optional(),
});

export type SsoProviderInput = z.infer<typeof base>;

/** Builds the resolver schema; `create` additionally requires the protocol's secret. */
export function ssoProviderSchema(mode: "create" | "edit") {
	return base.superRefine((v, ctx) => {
		const httpUrl = (s: string | undefined) => Boolean(s && /^https:\/\//.test(s));
		if (v.type === "oidc") {
			if (!httpUrl(v.issuer)) {
				ctx.addIssue({
					code: "custom",
					path: ["issuer"],
					message: "Must be an https:// issuer URL",
				});
			}
			if (!v.clientId) {
				ctx.addIssue({
					code: "custom",
					path: ["clientId"],
					message: "Client ID is required",
				});
			}
			if (mode === "create" && !v.clientSecret) {
				ctx.addIssue({
					code: "custom",
					path: ["clientSecret"],
					message: "Client secret is required",
				});
			}
		} else {
			if (!httpUrl(v.entryPoint)) {
				ctx.addIssue({
					code: "custom",
					path: ["entryPoint"],
					message: "Must be an https:// sign-on URL",
				});
			}
			if (mode === "create" && !v.cert) {
				ctx.addIssue({
					code: "custom",
					path: ["cert"],
					message: "The IdP signing certificate is required",
				});
			}
		}
	});
}
