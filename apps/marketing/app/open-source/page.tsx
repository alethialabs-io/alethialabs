// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { SiteShell } from "@repo/brand/site-shell";
import { getGitHubStars } from "@repo/brand/github-stars";
import { Reveal } from "@/components/landing/home/reveal";
import { OpenSourceSections } from "@/components/landing/open-source/page-sections";

export const metadata: Metadata = {
	title: "Open source · Alethia",
	description:
		"Alethia is open source under the GNU AGPL. Self-host the whole multi-cloud Kubernetes control plane — console, CLI, runners, provisioning — on your own infrastructure, closed-origin behind a Cloudflare Tunnel, on any of five clouds. AGPL core; one commercial boundary under ee/.",
};

/**
 * Public open-source / self-hosting landing page. Mirrors the home/enterprise chrome
 * (landing Header + Footer) and renders the open-source sections inside the shared
 * scroll-reveal wrapper. Served at /open-source by the marketing zone.
 */
export default async function OpenSourcePage() {
	// Fetched again for the section body; Next's fetch cache dedupes it with the
	// call SiteShell makes for the header.
	const stars = await getGitHubStars();
	return (
		<SiteShell>
			<Reveal>
				<OpenSourceSections stars={stars} />
			</Reveal>
		</SiteShell>
	);
}
