// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { AuthCard, AuthShell } from "@/components/auth/auth-shell";
import { pageMetadata } from "@/lib/seo/page-metadata";

// The page itself is a client component (it owns the approval gesture and its stages), so it
// cannot export metadata. This layout is where the route's title lives.
export const metadata = pageMetadata({
	title: "Approve CLI sign-in",
	description: "Confirm the device code your terminal printed to sign the Alethia CLI in.",
});

/**
 * The frame for `/cli/login` — and #3834 left the question of whether there should be one to
 * this issue. The answer is yes, and it belongs HERE rather than in `page.tsx`.
 *
 * The shell was mounted from inside the page, which is why the route scored FAIL on both of
 * RUBRIC.md's width predicates while visibly wearing the right chrome. S1 asks whether a known
 * shell is mounted somewhere in the LAYOUT CHAIN, and S2 asks whether the one max-width
 * governing the content comes from that shell rather than from the page — a page that mounts
 * its own shell answers "no" to both, and the next screen added to this segment would have had
 * to remember to mount it again. Moving the two lines up makes the pass-through layout the
 * thing that carries the route, and `loading.tsx` next door then renders inside the same card
 * instead of over a bare viewport.
 *
 * `AuthShell` is a client component; rendering one from a server layout is ordinary, and it is
 * what keeps `metadata` above exportable.
 */
export default function CliLoginLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<AuthShell>
			<AuthCard>{children}</AuthCard>
		</AuthShell>
	);
}
