// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { AnchorHTMLAttributes } from "react";

/**
 * A plain anchor for the site chrome (header and footer). Deliberately NOT next/link: the chrome is
 * rendered by several apps — marketing at `/`, News under basePath `/news`, the console — and its
 * links cross between them. next/link prefixes every href with the CURRENT app's basePath, so on
 * the News app `/pricing` became `/news/pricing` (a 404). A plain `<a>` navigates to exactly the
 * path written, which is what a link into another app needs.
 */
export function SiteLink(props: AnchorHTMLAttributes<HTMLAnchorElement>) {
	return <a {...props} />;
}
