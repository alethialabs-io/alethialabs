// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { MarketingHome } from "@/components/landing/home/marketing-home";

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
	return <MarketingHome />;
}
