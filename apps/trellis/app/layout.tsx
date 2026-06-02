import type { Metadata } from "next";
import "@xyflow/react/dist/style.css";
import { PublicEnvScript } from "next-runtime-env";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const geistSans = Geist({
	variable: "--font-geist-sans",
	subsets: ["latin"],
});

const geistMono = Geist_Mono({
	variable: "--font-geist-mono",
	subsets: ["latin"],
});

export const metadata: Metadata = {
	title: "Trellis",
	description:
		"Configure multi-cloud infrastructure in the browser. Deploy from the terminal.",
	icons: {
		icon: [
			{
				url: "/itgix-favicon-16x16.png",
				sizes: "16x16",
				type: "image/png",
			},
			{
				url: "/itgix-favicon-32x32.png",
				sizes: "32x32",
				type: "image/png",
			},
			{
				url: "/itgix-favicon-48x48.png",
				sizes: "48x48",
				type: "image/png",
			},
		],
		apple: [
			{
				url: "/itgix-favicon-112x112.png",
				sizes: "112x112",
				type: "image/png",
			},
		],
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
				className={`${geistSans.variable} ${geistMono.variable} antialiased`}
			>
				<ThemeProvider
					attribute="class"
					defaultTheme="dark"
					enableSystem
				>
					{children}
					<Toaster />
				</ThemeProvider>
			</body>
		</html>
	);
}
