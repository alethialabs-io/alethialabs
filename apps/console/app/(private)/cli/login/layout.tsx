// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { pageMetadata } from "@/lib/seo/page-metadata";

// The page itself is a client component (it owns the approval gesture and its stages), so it
// cannot export metadata. This pass-through layout is where the route's title lives.
// Whether the route should be wrapped in a shell at all is #3631's decision, not this one's.
export const metadata = pageMetadata({
	title: "Approve CLI sign-in",
	description: "Confirm the device code your terminal printed to sign the Alethia CLI in.",
});

export default function CliLoginLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
