// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { Header } from "@/components/landing/home/header";
import { Footer } from "@/components/landing/home/footer";
import { Reveal } from "@/components/landing/home/reveal";
import { OpenSourceSections } from "@/components/landing/open-source/page-sections";
import { getGitHubStars } from "@/lib/github-stars";

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
	const stars = await getGitHubStars();
	return (
		<div className="min-h-screen bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
			<Header stars={stars} />
			<Reveal>
				<OpenSourceSections stars={stars} />
			</Reveal>
			<Footer />
		</div>
	);
}
