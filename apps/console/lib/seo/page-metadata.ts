// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";

interface PageMetaInput {
	/** Page title; the root layout template renders it as "<title> — Alethia". */
	title: string;
	/** One-line description for the tab, OpenGraph, and Twitter cards. */
	description: string;
}

/**
 * Builds per-page `Metadata` with consistent OpenGraph + Twitter cards from a title and
 * description. The root layout supplies `metadataBase`, the title template, and the
 * default OG image, so pages only declare what differs. Used across the console's
 * authenticated routes for correct tab titles and shareable link previews.
 */
export function pageMetadata({ title, description }: PageMetaInput): Metadata {
	return {
		title,
		description,
		openGraph: {
			title: `${title} — Alethia`,
			description,
			type: "website",
			siteName: "Alethia",
		},
		twitter: {
			card: "summary_large_image",
			title: `${title} — Alethia`,
			description,
		},
	};
}
