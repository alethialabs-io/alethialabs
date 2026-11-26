// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What the privacy pages, their client forms and their server actions share (#7222). Kept apart
// from data.ts, which calls the console, so the client forms can import it.
//
// A sibling app may not import console code (apps/admin/eslint.config.mjs), so the request kinds,
// the case states and the reason lengths are restated from apps/console/lib/privacy/case-steps.ts
// and the `privacy_case_kind` / `privacy_case_state` enums. The console is the authority on every
// one of them: a reason this side lets through and the console refuses comes back as the console's
// own message, and a kind or state the console adds fails data.ts's parse loudly instead of
// rendering as something it is not.

/** The request kinds, in the order the open form offers them. */
export const PRIVACY_KINDS = [
	"erasure",
	"access",
	"export",
	"rectification",
	"restriction",
	"objection",
	"portability",
] as const;

/** One request kind. */
export type PrivacyKind = (typeof PRIVACY_KINDS)[number];

/** The case states, as the console's enum declares them. */
export const PRIVACY_STATES = [
	"received",
	"identity_pending",
	"in_review",
	"fulfilled",
	"refused",
	"withdrawn",
] as const;

/** One case state. */
export type PrivacyState = (typeof PRIVACY_STATES)[number];

/** The shortest extension reason or legal-hold basis the console accepts. */
export const MIN_EXTENSION_REASON = 10;

/** The shortest refusal grounds the console accepts: the reason AND the right to complain. */
export const MIN_REFUSAL_REASON = 20;

/** The shortest note on how identity was verified. It goes to the platform audit trail only. */
export const MIN_VERIFICATION_NOTE = 10;

/** The shape of a reference the console mints: `DSR-` and eight upper-case hex characters. */
export const REFERENCE_PATTERN = /^DSR-[0-9A-F]{8}$/;
