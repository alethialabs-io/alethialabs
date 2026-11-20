// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Where the shell's outbound links point, decided once from the instance edition.
//
// The hosted service has a status page, a marketing site, legal pages and a feedback inbox, all
// run by Alethia Labs. A self-managed instance has none of them: its operator never promised the
// uptime our status page reports, and a "Home page" link there used to lead to our marketing
// site. So on a self-managed instance each of those links is the one the operator configured for
// THEIR instance, or it is absent. It is never a hosted address used as a fallback.
//
// Two links are the same everywhere, because they are about the software and not about a service:
// the release notes and the public source repository.
//
// `resolveInstanceLinks` is pure and takes the configured values, so every row of the table above
// is unit tested (`tests/components/shell/instance-links.test.ts`). `instanceLinks` reads the
// values. The `env("NEXT_PUBLIC_…")` calls are written out literally on purpose:
// `tests/unit/dockerfile-runtime-public-env.test.ts` finds runtime reads by that exact form.

import { env } from "next-runtime-env";
import { legalUrl, statusUrl } from "@/lib/legal";
import { isHostedService, type ShellEdition } from "./shell-edition";

/** The public source repository. */
const SOURCE_REPOSITORY = "https://github.com/alethialabs-io/alethialabs";

/** The software's release notes. */
const RELEASE_NOTES = `${SOURCE_REPOSITORY}/releases`;

/** Where a self-managed instance reports an issue unless its operator configured another tracker. */
const DEFAULT_ISSUES_URL = `${SOURCE_REPOSITORY}/issues/new`;

/** How the account menu takes a report about the product. */
export type ReportChannel =
	/** The in-app feedback dialog, which writes to Alethia Labs. Hosted service only. */
	| { kind: "feedback" }
	/** An issue tracker, opened in a new tab. */
	| { kind: "issues"; href: string };

/** The shell's outbound links. A `null` link is not rendered. */
export interface InstanceLinks {
	/** The status page of the service this instance is, or null when it has none. */
	status: string | null;
	/** The product's home page, or null when this instance has none. */
	home: string | null;
	/** The software's release notes. */
	releaseNotes: string;
	/** Where the source and its licences are published. */
	source: string;
	/** How a report about the product is taken. */
	report: ReportChannel;
}

/** The values a deployment may configure. `undefined` is "not set"; `""` is a set, empty value. */
export interface ConfiguredLinks {
	/** `NEXT_PUBLIC_STATUS_URL`. Empty turns the status link off. */
	statusUrl: string | undefined;
	/** `NEXT_PUBLIC_LEGAL_URL`: the base the marketing and legal pages are served from. Empty is this origin. */
	legalBase: string | undefined;
	/** `NEXT_PUBLIC_FEEDBACK_REPO_URL`: the issue tracker a self-managed instance reports to. */
	issuesUrl: string | undefined;
	/** The hosted service's status page: the configured one, the hosted default, or null when turned off. */
	hostedStatusUrl: string | null;
	/** The hosted service's source-and-licences page. */
	hostedSourceUrl: string;
}

/**
 * The shell's links for an instance. An edition that is not known is treated as self-managed:
 * no hosted address is offered on a guess.
 */
export function resolveInstanceLinks(
	edition: ShellEdition | null,
	configured: ConfiguredLinks,
): InstanceLinks {
	if (isHostedService(edition)) {
		return {
			status: configured.hostedStatusUrl,
			home: "/home",
			releaseNotes: RELEASE_NOTES,
			source: configured.hostedSourceUrl,
			report: { kind: "feedback" },
		};
	}
	const { statusUrl: status, legalBase, issuesUrl } = configured;
	return {
		status: status === undefined || status === "" ? null : status,
		home: legalBase === undefined ? null : `${legalBase}/`,
		releaseNotes: RELEASE_NOTES,
		source: legalBase === undefined ? SOURCE_REPOSITORY : `${legalBase}/legal/source`,
		report: {
			kind: "issues",
			href: issuesUrl === undefined || issuesUrl === "" ? DEFAULT_ISSUES_URL : issuesUrl,
		},
	};
}

/** The shell's links for this instance, from its edition and what its deployment configured. */
export function instanceLinks(edition: ShellEdition | null): InstanceLinks {
	return resolveInstanceLinks(edition, {
		statusUrl: env("NEXT_PUBLIC_STATUS_URL"),
		legalBase: env("NEXT_PUBLIC_LEGAL_URL"),
		issuesUrl: env("NEXT_PUBLIC_FEEDBACK_REPO_URL"),
		hostedStatusUrl: statusUrl(),
		hostedSourceUrl: legalUrl("/legal/source"),
	});
}
