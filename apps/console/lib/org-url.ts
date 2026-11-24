// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Canonical organization URL. The console is the microfrontends *default* zone,
// served at the app root, so an org lives at `{host}/{slug}` (e.g.
// `alethia.example.com/acme`) — never a `console.` subdomain. Single source of truth
// for the host shown in onboarding + settings.
//
// The host is THIS instance's, read from `NEXT_PUBLIC_APP_URL` at runtime (`next-runtime-env`,
// so a prebuilt self-host image shows its operator's value). There is no hosted default (#7417,
// after EDN-H7 #6904): an instance with no origin configured shows the org's path on itself
// (`/acme`), never the hosted service's domain. The hosted service sets `NEXT_PUBLIC_APP_URL`
// like any other instance, so it needs no literal here.

import { env } from "next-runtime-env";

/** The bare host the console is served at (no protocol / trailing slash), derived from
 *  NEXT_PUBLIC_APP_URL. "" when that is unset or carries no host. */
export function orgHost(): string {
	const raw = (env("NEXT_PUBLIC_APP_URL") ?? "").trim();
	if (!raw) return "";
	try {
		return new URL(raw).host;
	} catch {
		return raw.replace(/^https?:\/\//, "").replace(/\/+$/, "");
	}
}

/** Display URL for an organization, e.g. `alethia.example.com/acme`; `/acme` with no origin set. */
export function orgUrl(slug: string): string {
	return `${orgHost()}/${slug}`;
}
