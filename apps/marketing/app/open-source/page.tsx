// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { SiteShell } from "@repo/brand/site-shell";
import { getGitHubStars } from "@repo/brand/github-stars";
import { Reveal } from "@/components/landing/reveal";
import { OpenSourceSections } from "@/components/landing/open-source/page-sections";

export const metadata: Metadata = {
	title: "Open source",
	description:
		"Alethia is open source under the GNU AGPL. Self-host the whole multi-cloud Kubernetes control plane — console, CLI, runners, provisioning — on your own infrastructure, closed-origin behind a Cloudflare Tunnel, on any of four clouds. AGPL core; one commercial boundary under ee/.",
};

/**
 * Public open-source / self-hosting landing page. Mirrors the home/enterprise chrome
 * (landing Header + Footer) and renders the open-source sections inside the shared
 * scroll-reveal wrapper. Served at /open-source by the marketing zone.
 */
export default async function OpenSourcePage() {
	// The header no longer shows a star count, so this page is the one place
	// that fetches it (cached hourly, `null` when GitHub does not answer).
	const stars = await getGitHubStars();
	return (
		<SiteShell>
			<Reveal>
				<OpenSourceSections stars={stars} />
			</Reveal>
		</SiteShell>
	);
}
