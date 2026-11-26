// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { PublicEnvScript } from "next-runtime-env";
import { brandFontVariables } from "@repo/brand/fonts";
import { INTRO_GATE_SCRIPT } from "@repo/brand/site-intro-gate";
import { IntroSplash } from "@repo/brand/site-intro-splash";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@repo/ui/sonner";
import { ConsentProvider } from "@repo/privacy/consent-provider";
import { cloudListLabel } from "@repo/cloud-catalog";
import { RELEASE_STAGE } from "@repo/legal/launch";
import { SITE_URL } from "@/lib/site";
import "./globals.css";

// The description is what a search result and a link preview show, so it carries the stage
// name too — `RELEASE_STAGE`, never a literal (EA-4, #7326). The cloud names come from the
// catalog, never a literal list.
const SITE_DESCRIPTION = `Configure multi-cloud infrastructure in the browser. Deploy from the terminal. In ${RELEASE_STAGE} on ${cloudListLabel()}.`;

export const metadata: Metadata = {
	metadataBase: new URL(SITE_URL),
	title: {
		default: "Alethia",
		// Pages set the bare name ("Pricing"); the template adds the product once.
		template: "%s · Alethia",
	},
	description: SITE_DESCRIPTION,
	applicationName: "Alethia",
	openGraph: {
		title: "Alethia",
		description: SITE_DESCRIPTION,
		url: "/",
		siteName: "Alethia",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "Alethia",
		description: SITE_DESCRIPTION,
	},
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				{/* The intro splash's once-per-session gate (#7742). Inline and first in <head>, so
				    it runs before first paint: a repeat load in this session gets
				    `data-intro="skip"` on <html> and the splash is `display: none` before it can
				    paint. No CSP is set on this app (no header, no nonce), so an inline script
				    needs nothing more; if one is added, this script needs its nonce or hash, like
				    next-themes' and PublicEnvScript's. `suppressHydrationWarning` on <html> already
				    covers the attribute it writes. */}
				<script dangerouslySetInnerHTML={{ __html: INTRO_GATE_SCRIPT }} />
				<PublicEnvScript />
			</head>
			<body
				className={`${brandFontVariables} antialiased`}
			>
				{/* The site follows the visitor's OS and offers no control of its own:
				    the header switcher is gone, and a marketing page is the wrong place to
				    ask someone to configure anything. Both themes are therefore a SHIPPED
				    surface — a visitor lands on either, so neither may be left unpolished.
				    `apps/blog` defaults the same way, so the theme no longer flips when you
				    cross between zones. A returning visitor whose choice is already in
				    `localStorage` keeps it; the console, same origin and same key, still has
				    a switcher. */}
				{/* First in <body>, so nothing paints before it on a first load. Marketing's
				    root layout only: the blog, the docs and the console never show it. */}
				<IntroSplash />
				<ThemeProvider attribute="class" defaultTheme="system" enableSystem>
					<ConsentProvider>
						{children}
						<Toaster />
					</ConsentProvider>
				</ThemeProvider>
			</body>
		</html>
	);
}
