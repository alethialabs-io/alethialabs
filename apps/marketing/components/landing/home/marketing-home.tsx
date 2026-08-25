// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { SiteShell } from "@repo/brand/site-shell";

import { Close, KeepBeat, ReceiptBeat } from "./beats";
import { Hero } from "./hero";

/**
 * The Alethia homepage, used by both the anonymous root and the authenticated
 * `/home` alias.
 *
 * One screen that argues, two that show, then the close — roughly 155 words. The
 * previous version ran ten sections and ~700 words across 5,138 lines of
 * hand-rebuilt console UI; none of the sites we are measured against do that.
 *
 * It no longer carries its own chrome. It used to mount the frame, the rails and
 * a private `.mkt-root` that set Geist Mono as the BODY face at 13px — the
 * inverse of every other page and of the console, which is most of why the home
 * page read as a different product. The frame and rails were the good part and
 * are now site-wide (`SiteShell`); the type inversion is gone.
 */
export async function MarketingHome({ homeHref = "/" }: { homeHref?: "/" | "/home" }) {
	return (
		<SiteShell homeHref={homeHref}>
			<Hero />
			<ReceiptBeat />
			<KeepBeat />
			<Close />
		</SiteShell>
	);
}
