// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { PublicEnvScript } from "next-runtime-env";
import { Geist, Geist_Mono, Space_Grotesk } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@repo/ui/sonner";
import "./globals.css";

const geistSans = Geist({
	variable: "--font-geist-sans",
	subsets: ["latin"],
});

const geistMono = Geist_Mono({
	variable: "--font-geist-mono",
	subsets: ["latin"],
});

const spaceGrotesk = Space_Grotesk({
	variable: "--font-space-grotesk",
	subsets: ["latin"],
	weight: ["400", "500", "600", "700"],
});

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
				className={`${geistSans.variable} ${geistMono.variable} ${spaceGrotesk.variable} antialiased`}
			>
				<ThemeProvider
					attribute="class"
					defaultTheme="light"
					enableSystem={false}
				>
					{children}
					<Toaster />
				</ThemeProvider>
			</body>
		</html>
	);
}
