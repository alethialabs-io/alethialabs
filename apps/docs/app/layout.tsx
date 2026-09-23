// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import { brandFontVariables } from '@repo/brand/fonts';

// The docs ran on Inter while every other surface ran Geist + Space Grotesk, which
// made /docs read as a different product the moment you clicked through from the
// footer. Same three faces, same variable names as every other app: @repo/brand/fonts.

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={brandFontVariables}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen font-sans antialiased">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
