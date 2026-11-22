// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Temporary-inbox services a new account may not be created with (REL-L10, #6911).
//
// WHAT THIS LIST IS. The widely used throwaway-inbox services: sites whose whole purpose is an
// address that works for minutes and is then abandoned. An account opened with one has no owner we
// can reach — no billing notice, no security notice, no trial reminder lands anywhere.
//
// WHAT IT IS NOT. Not exhaustive, and it cannot be: new throwaway domains appear daily. It is a
// cheap first filter behind the challenge and the per-network ceiling, not the only control. It is
// also not a list of free mail providers — gmail.com, outlook.com, proton.me and the like are real,
// long-lived inboxes and are never listed here. Nor are forwarding-alias services, which deliver
// to a real inbox the owner keeps.
//
// MATCHING. A listed domain also covers every subdomain of it (`x.mailinator.com`), because several
// of these services hand out per-user subdomains. Matching is on the lower-cased domain after the
// last `@`.
//
// Adding a domain: lower case, no leading `@` or dot. The unit test fails on a duplicate, an
// upper-case or malformed entry, or a free mail provider in the list.

/** The throwaway-inbox domains, lower case. */
export const DISPOSABLE_EMAIL_DOMAINS: readonly string[] = [
	"10minutemail.com",
	"10minutemail.net",
	"20minutemail.com",
	"anonbox.net",
	"anonymbox.com",
	"byom.de",
	"discard.email",
	"discardmail.com",
	"discardmail.de",
	"dispostable.com",
	"dropmail.me",
	"emailondeck.com",
	"emailsensei.com",
	"emailtemporanea.com",
	"emailtemporanea.net",
	"fakeinbox.com",
	"fakemail.net",
	"fakemailgenerator.com",
	"getairmail.com",
	"getnada.com",
	"guerrillamail.biz",
	"guerrillamail.com",
	"guerrillamail.de",
	"guerrillamail.info",
	"guerrillamail.net",
	"guerrillamail.org",
	"guerrillamailblock.com",
	"harakirimail.com",
	"incognitomail.org",
	"inboxbear.com",
	"inboxkitten.com",
	"jetable.org",
	"mail-temp.com",
	"mail.tm",
	"mailcatch.com",
	"maildrop.cc",
	"mailinator.com",
	"mailinator.net",
	"mailinator2.com",
	"mailnesia.com",
	"mailpoof.com",
	"mailsac.com",
	"mailtemp.info",
	"mintemail.com",
	"moakt.com",
	"mohmal.com",
	"mytemp.email",
	"mytrashmail.com",
	"nada.email",
	"noclickemail.com",
	"nowmymail.com",
	"sharklasers.com",
	"spam4.me",
	"spambog.com",
	"spambox.us",
	"tempail.com",
	"tempinbox.com",
	"tempm.com",
	"tempmail.dev",
	"tempmail.net",
	"tempmail.plus",
	"tempmailo.com",
	"temp-mail.io",
	"temp-mail.org",
	"tempr.email",
	"throwawaymail.com",
	"tmail.ws",
	"tmpmail.net",
	"tmpmail.org",
	"trash-mail.com",
	"trashmail.com",
	"trashmail.de",
	"trashmail.me",
	"trashmail.net",
	"trbvm.com",
	"wegwerfmail.de",
	"wegwerfmail.net",
	"yopmail.com",
	"yopmail.fr",
	"yopmail.net",
];

const DOMAINS: ReadonlySet<string> = new Set(DISPOSABLE_EMAIL_DOMAINS);

/** The lower-cased domain of an email address (after the last `@`), or null when there is none. */
export function emailDomain(email: string): string | null {
	const at = email.lastIndexOf("@");
	if (at < 0) return null;
	const domain = email
		.slice(at + 1)
		.trim()
		.toLowerCase()
		.replace(/\.+$/, "");
	return domain === "" ? null : domain;
}

/**
 * Whether an address belongs to a listed temporary-inbox service — its domain, or any parent
 * domain of it, is on {@link DISPOSABLE_EMAIL_DOMAINS}.
 */
export function isDisposableEmail(email: string): boolean {
	const domain = emailDomain(email);
	if (domain === null) return false;
	const labels = domain.split(".");
	for (let i = 0; i < labels.length - 1; i++) {
		if (DOMAINS.has(labels.slice(i).join("."))) return true;
	}
	return false;
}
