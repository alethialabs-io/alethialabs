// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { PublicEnvScript } from "next-runtime-env";
import { brandFontVariables } from "@repo/brand/fonts";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@repo/ui/sonner";
import { QueryProvider } from "@/components/query-provider";
import "./globals.css";

export const metadata: Metadata = {
	title: {
		default: "Support admin",
		template: "%s — Support admin",
	},
	description: "Cross-tenant support console for Alethia staff.",
	robots: { index: false, follow: false },
};

/**
 * The admin root layout — a minimal grayscale/dark chrome (html/body + fonts +
 * ThemeProvider), the shared toaster, and the TanStack QueryClient provider so every page
 * hydrates server-prefetched cases. Cloudflare Access gates the whole subdomain; the
 * per-page `getStaff()` check is defense-in-depth.
 */
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
				<ThemeProvider
					attribute="class"
					defaultTheme="dark"
					enableSystem={false}
				>
					<QueryProvider>{children}</QueryProvider>
					<Toaster />
				</ThemeProvider>
			</body>
		</html>
	);
}
