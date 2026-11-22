// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { SiteShell } from "@repo/brand/site-shell";
import { OpenSourceSections } from "@/components/landing/open-source/page-sections";

export const metadata: Metadata = {
	title: "Open source",
	description:
		"The Alethia control plane is open source under the GNU AGPL-3.0. Run it on your own infrastructure with Docker Compose, OpenTofu, Helm or a one-click template; the commercial code lives in one directory, ee/.",
};

/** The public open-source / self-hosting page, served at /open-source by the marketing zone. */
export default function OpenSourcePage() {
	return (
		<SiteShell>
			<OpenSourceSections />
		</SiteShell>
	);
}
