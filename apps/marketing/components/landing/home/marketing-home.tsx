// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getGitHubStars } from "@/lib/github-stars";
import { Footer } from "./footer";
import { Header } from "./header";
import { RunsMarquee } from "./motion/runs-marquee";
import { CanvasSection } from "./sections/canvas";
import { Closing } from "./sections/closing";
import { Fleet } from "./sections/fleet";
import { Flows } from "./sections/flows";
import { Hero } from "./sections/hero";
import { Keyless } from "./sections/keyless";
import { ParityMatrix } from "./sections/parity-matrix";
import { Spine } from "./sections/spine";
import { VerifyGate } from "./sections/verify-gate";

/**
 * The shared Alethia homepage narrative used by both the anonymous root and the
 * authenticated `/home` alias.
 */
export async function MarketingHome({ homeHref = "/" }: { homeHref?: "/" | "/home" }) {
	const stars = await getGitHubStars();

	return (
		<div className="min-h-screen bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
			<Header stars={stars} homeHref={homeHref} />
			<main>
				<Hero />
				<RunsMarquee />
				<Keyless />
				<Spine />
				<CanvasSection />
				<VerifyGate />
				<ParityMatrix />
				<Fleet />
				<Flows />
				<Closing />
			</main>
			<Footer />
		</div>
	);
}
