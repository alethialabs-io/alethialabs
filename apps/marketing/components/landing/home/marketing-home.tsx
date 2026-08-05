// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getGitHubStars } from "@/lib/github-stars";
import { Close, ConsoleBeat, KeepBeat } from "./beats";
import { Chrome } from "./chrome";
import { Footer } from "./footer";
import { Header } from "./header";
import { Hero } from "./hero";

/**
 * The Alethia homepage, used by both the anonymous root and the authenticated
 * `/home` alias.
 *
 * One screen that argues, two that show, then the close — roughly 155 words. The
 * previous version ran ten sections and ~700 words across 5,138 lines of
 * hand-rebuilt console UI; none of the sites we are measured against do that.
 */
export async function MarketingHome({ homeHref = "/" }: { homeHref?: "/" | "/home" }) {
	const stars = await getGitHubStars();

	return (
		<div className="mkt-root">
			<Chrome />
			<Header stars={stars} homeHref={homeHref} />
			<main>
				<Hero />
				<ConsoleBeat />
				<KeepBeat />
				<Close />
			</main>
			<Footer />
		</div>
	);
}
