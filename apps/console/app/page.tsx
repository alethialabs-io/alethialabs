// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";
import { getOwner } from "@/lib/auth/owner";
import { getActiveOrgSlug } from "@/app/server/actions/resolve";
import { getGitHubStars } from "@/lib/github-stars";
import { Header } from "@/components/landing/home/header";
import { Hero } from "@/components/landing/home/hero";
import { RunsOn } from "@/components/landing/home/runs-on";
import { ZeroTrust } from "@/components/landing/home/zero-trust";
import { SpecDesigner } from "@/components/landing/home/spec-designer";
import { SpecsJobs } from "@/components/landing/home/specs-jobs";
import { FleetTeaser } from "@/components/landing/home/fleet-teaser";
import { AI } from "@/components/landing/home/ai";
import { Alerts } from "@/components/landing/home/alerts";
import { Enterprise } from "@/components/landing/home/enterprise";
import { Cli } from "@/components/landing/home/cli";
import { CTA } from "@/components/landing/home/cta";
import { Footer } from "@/components/landing/home/footer";
import { Reveal } from "@/components/landing/home/reveal";

/**
 * Alethia Labs public home page — multi-cloud Kubernetes control plane.
 * Authenticated visitors skip the marketing page and load straight into the
 * console at their active organization.
 */
export default async function HomePage() {
	const userId = await getOwner();
	if (userId) {
		redirect(`/${await getActiveOrgSlug()}`);
	}
	const stars = await getGitHubStars();

	return (
		<div className="min-h-screen bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
			<Header stars={stars} />
			<Reveal>
				<Hero />
				<RunsOn />
				<ZeroTrust />
				<SpecDesigner />
				<SpecsJobs />
				<FleetTeaser />
				<AI />
				<Alerts />
				<Enterprise />
				<Cli />
				<CTA />
			</Reveal>
			<Footer />
		</div>
	);
}
