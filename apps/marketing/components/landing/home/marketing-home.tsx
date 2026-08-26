// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { SiteShell } from "@repo/brand/site-shell";

import {
	Announce,
	CliBand,
	Clouds,
	Close,
	ConsoleBand,
	Hero,
	ReceiptBand,
} from "./sections";

/**
 * The home page: hero, what it runs on, three bands, close.
 *
 * The announcement line sits inside `main` rather than above the header, where
 * its Vercel counterpart lives — `SiteShell` is shared with apps/blog, so a bar
 * added above the header would ship there too. It reads identically here.
 */
export async function MarketingHome({ homeHref = "/" }: { homeHref?: "/" | "/home" }) {
	return (
		<SiteShell homeHref={homeHref}>
			<Announce />
			<Hero />
			<Clouds />
			<ConsoleBand />
			<CliBand />
			<ReceiptBand />
			<Close />
		</SiteShell>
	);
}
