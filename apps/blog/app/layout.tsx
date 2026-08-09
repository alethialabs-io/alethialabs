// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "./global.css";
import type { Metadata } from "next";
import { Geist, Geist_Mono, Space_Grotesk } from "next/font/google";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

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
				{/* There was no ThemeProvider at all, so `.dark` never applied and the
				    stylesheet's whole dark block was dead code. */}
				<ThemeProvider attribute="class" defaultTheme="light" enableSystem>
					<SiteHeader />
					<main className="flex-1">{children}</main>
					<SiteFooter />
				</ThemeProvider>
			</body>
		</html>
	);
}
