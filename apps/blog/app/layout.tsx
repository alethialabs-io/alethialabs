// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "./global.css";
import type { Metadata } from "next";
import { Geist, Geist_Mono, Space_Grotesk } from "next/font/google";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { Chrome } from "@repo/brand/site-chrome";
import { ConsentProvider } from "@repo/brand/site-consent";
import { SiteFooter } from "@repo/brand/site-footer";
import { Header as SiteHeader } from "@repo/brand/site-header";

// `--font-geist-sans`, not `--font-geist`: @repo/brand/tokens.css maps --font-sans to it.
const geist = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });
const spaceGrotesk = Space_Grotesk({
	subsets: ["latin"],
	variable: "--font-space-grotesk",
	weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
	metadataBase: new URL("https://alethialabs.io"),
	title: {
		default: "Alethia Blog",
		template: "%s · Alethia Blog",
	},
	description:
		"Engineering deep dives from Alethia Labs — a multi-cloud control plane you run in your own cloud.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html
			lang="en"
			className={`${geist.variable} ${geistMono.variable} ${spaceGrotesk.variable}`}
			suppressHydrationWarning
		>
			<body className="min-h-screen flex flex-col bg-background text-foreground">
				{/* Matches apps/marketing: follow the OS, no switcher. It used to default
				    to `light` while marketing defaulted to `dark`, so the theme flipped as
				    soon as a visitor crossed from the site into the blog. */}
				{/* The shared footer carries the consent control (PrivacySettingsButton →
				    useConsent), which THROWS without a provider — so promoting the chrome to
				    @repo/brand moved the footer into this app without the contract it depends on,
				    and `/` stopped prerendering. Same reasoning as the theme comment above: one
				    chrome across two zones means both zones owe it the same providers.

				    Consent genuinely CROSSES here rather than being answered twice: the record is
				    a host-only cookie at `Path=/` (packages/privacy/src/consent.ts), and the blog
				    is the same host under `basePath: "/blog"` — so a choice made on the marketing
				    site is already in effect on arrival. Imported from @repo/brand, which already
				    depends on @repo/privacy, so this app does not take a second direct dependency
				    for a contract its chrome brought with it. */}
				<ThemeProvider attribute="class" defaultTheme="system" enableSystem>
					<ConsentProvider>
						<Chrome />
						<SiteHeader />
						<main className="flex-1">{children}</main>
						<SiteFooter />
					</ConsentProvider>
				</ThemeProvider>
			</body>
		</html>
	);
}
