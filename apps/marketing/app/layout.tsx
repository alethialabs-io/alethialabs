// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { PublicEnvScript } from "next-runtime-env";
import { brandFontVariables } from "@repo/brand/fonts";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@repo/ui/sonner";
import { ConsentProvider } from "@repo/privacy/consent-provider";
import "./globals.css";

const SITE_DESCRIPTION =
	"Configure multi-cloud infrastructure in the browser. Deploy from the terminal.";

export const metadata: Metadata = {
	metadataBase: new URL("https://alethialabs.io"),
	title: {
		default: "Alethia",
		template: "%s — Alethia",
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
