"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@repo/ui/utils";
import Image from "next/image";
import { useState } from "react";

// THIRD-PARTY MARKS ARE RENDERED AS THEIR OWNERS SUPPLY THEM (#3907). Every owner of the connector
// marks under `/icons/` publishes terms that forbid changing a logo's colour, so the grayscale
// treatment below is for the marks that are not third-party connector marks — and each ruling is
// recorded, with its reason, in docs/legal/DESIGN_SYSTEM_AUDIT.md ("Rulings, 2026-09-30").
//
// The rule is keyed on the PATH, and the boundary is stated rather than implied: a connector mark
// lives under `packages/assets/static/icons/<slug>/` and is served at `/icons/<slug>/…`; the cloud
// marks live at `/<cloud>/favicon_*.png`, and whether THEY may be desaturated is a separate
// question (#3907's "hyperscaler" item) that this file does not answer.

/** The public path prefix every third-party connector mark is served under. */
const THIRD_PARTY_MARK_PREFIX = "/icons/";

/**
 * Marks whose owner supplies a separate file for dark backgrounds. GitHub publishes the Invertocat
 * in black and in white (brand.github.com, `GitHub_Logos.zip`) and permits only those colours, so
 * the dark theme swaps to GitHub's white file rather than inverting the black one in CSS.
 */
const DARK_VARIANTS: Readonly<Record<string, string>> = {
	"/icons/github/GitHub_Invertocat_Black.png": "/icons/github/GitHub_Invertocat_White.png",
};

/**
 * Marks whose owner's grant covers ONLY a use that identifies the project and hyperlinks to it,
 * mapped to the page it must link to. HashiCorp allows its project logos on a website without
 * separate permission "so long as they are used only to identify and hyperlink to main page of
 * the specific HashiCorp project website" — so the Vault mark is always a link to Vault, and where
 * it cannot be one (inside a pick tile or a select option, which are controls themselves), the
 * monogram renders instead of the mark.
 */
const LINKED_MARKS: Readonly<Record<string, string>> = {
	"/icons/vault/vault-32x32.png": "https://developer.hashicorp.com/vault",
};

/**
 * Whether `src` is a third-party connector mark — one that must render in its owner's own colours,
 * so its call sites pass `mono={false}` whatever the connection state.
 */
export function isThirdPartyMark(src: string | null | undefined): boolean {
	return Boolean(src?.startsWith(THIRD_PARTY_MARK_PREFIX));
}

/**
 * Renders a connector's icon, falling back to a clean monogram tile if the image
 * is missing or fails to load (e.g. a cloud whose logo hasn't been added to
 * public/<slug>/ yet). Keeps the connectors UI from breaking on a 404. The logo
 * is grayscale by default (design system); pass `mono={false}` to show it in full
 * color — which every third-party connector mark takes (see {@link isThirdPartyMark}).
 *
 * `canLink` says the icon is NOT inside another control, so a mark whose owner requires it to
 * hyperlink to the project (Vault) may render as that link. Without it such a mark renders the
 * monogram.
 */
export function ConnectorIcon({
	src,
	name,
	size = 28,
	mono = true,
	canLink = false,
}: {
	src?: string | null;
	name: string;
	size?: number;
	mono?: boolean;
	canLink?: boolean;
}) {
	const [errored, setErrored] = useState(false);
	const linkTo = src ? LINKED_MARKS[src] : undefined;

	if (!src || errored || (linkTo !== undefined && !canLink)) {
		return (
			<span
				className="font-semibold text-muted-foreground select-none"
				style={{ fontSize: Math.round(size * 0.5) }}
				aria-hidden
			>
				{name.charAt(0).toUpperCase()}
			</span>
		);
	}

	const tone = cn("object-contain", mono && "grayscale opacity-90");
	const darkSrc = DARK_VARIANTS[src];
	const mark = darkSrc ? (
		<>
			<Image
				src={src}
				alt={name}
				width={size}
				height={size}
				className={cn(tone, "dark:hidden")}
				onError={() => setErrored(true)}
			/>
			{/* Both carry the name: `display: none` takes the hidden one out of the accessibility
			    tree, so exactly one is ever announced. */}
			<Image
				src={darkSrc}
				alt={name}
				width={size}
				height={size}
				className={cn(tone, "hidden dark:block")}
				onError={() => setErrored(true)}
			/>
		</>
	) : (
		<Image
			src={src}
			alt={name}
			width={size}
			height={size}
			className={tone}
			onError={() => setErrored(true)}
		/>
	);

	if (linkTo === undefined) return mark;
	return (
		<a
			href={linkTo}
			target="_blank"
			rel="noopener noreferrer"
			title={`${name} project site`}
			className="inline-flex"
		>
			{mark}
		</a>
	);
}
