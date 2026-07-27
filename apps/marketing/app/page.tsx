// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getGitHubStars } from "@/lib/github-stars";
import { Header } from "@/components/landing/home/header";
import { Footer } from "@/components/landing/home/footer";
import { RunsMarquee } from "@/components/landing/home/motion/runs-marquee";
import { Hero } from "@/components/landing/home/sections/hero";
import { Keyless } from "@/components/landing/home/sections/keyless";
import { Spine } from "@/components/landing/home/sections/spine";
import { CanvasSection } from "@/components/landing/home/sections/canvas";
import { VerifyGate } from "@/components/landing/home/sections/verify-gate";
import { ParityMatrix } from "@/components/landing/home/sections/parity-matrix";
import { Fleet } from "@/components/landing/home/sections/fleet";
import { Flows } from "@/components/landing/home/sections/flows";
import { Closing } from "@/components/landing/home/sections/closing";

/**
 * Alethia Labs public home page — the assembled scrollytelling narrative. A
 * self-evidencing hero opens, then eight numbered beats carry the argument:
 * keyless identity (01), the proof spine (02), the design canvas (03), the
 * fail-closed verify gate (04), multi-cloud parity (05), the self-healing fleet
 * (06), the two build flows (07), and the closing stack (08 → CTA). This stays an
 * async server component that resolves the GitHub star count and composes the
 * sections; each section is a client island owning its own reveal and motion.
 */
export default async function HomePage() {
	const stars = await getGitHubStars();

	return (
		<div className="min-h-screen bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
			<Header stars={stars} />
			<main>
				{/* Opening: the self-evidencing hero (ambient field + live proof pipeline). */}
				<Hero />
				{/* Connective rail into the sunken "Own it" beat. */}
				<RunsMarquee />
				{/* 01 — keyless federated identity. */}
				<Keyless />
				{/* 02 — the repo → proven cluster spine (sticky scrollytelling). */}
				<Spine />
				{/* 03 — the canvas as the design surface. */}
				<CanvasSection />
				{/* 04 — the fail-closed verify gate + signed receipt. */}
				<VerifyGate />
				{/* 05 — multi-cloud parity matrix. */}
				<ParityMatrix />
				{/* 06 — the self-healing runner fleet + drift reconciler. */}
				<Fleet />
				{/* 07 — the two build flows (Path B live, Path A roadmap). */}
				<Flows />
				{/* 08 → CTA — positioning, open source, enterprise, roadmap, conversion. */}
				<Closing />
			</main>
			<Footer />
		</div>
	);
}
