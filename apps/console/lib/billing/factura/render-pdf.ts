// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The one door to the фактура PDF renderer (#7413). It loads `./document` — and @react-pdf/renderer
// behind it — only when a PDF is actually rendered, never when a module that MIGHT render one is
// imported.
//
// WHY. The renderer is reachable from a long way off: lib/platform/provision → lib/email/billing-email
// → ./issue → ./document. Imported statically, @react-pdf/renderer is evaluated by everything on that
// path, and under plain `tsx` (how operator scripts run) it does not load at all — its textkit asks for
// `@react-pdf/hyphenate/en-us`, a subpath that package does not export, and Node refuses it. That made
// `provisionOrg` uncallable from any script. Next.js and vitest resolve it, so nothing in CI saw it.
//
// Import `renderFacturaPdf` from HERE, not from `./document`. tests/lib/platform/provision-loads.test.ts
// imports lib/platform/provision under plain tsx and fails if anything on that path pulls the renderer
// back in statically. Server-only.

import type { FacturaSnapshot } from "@/types/jsonb.types";

/** Renders the фактура `s` to PDF bytes, loading the PDF library on first use. Same snapshot, same bytes. */
export async function renderFacturaPdf(s: FacturaSnapshot): Promise<Uint8Array> {
	const { renderFacturaPdf: render } = await import("./document");
	return render(s);
}
