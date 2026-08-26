// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getPageImage, source } from '@/lib/source';
import { notFound } from 'next/navigation';
import { ImageResponse } from 'next/og';
import { generate as DefaultImage } from 'fumadocs-ui/og';
import { RAMP } from '@repo/brand/ramp-srgb';

export const revalidate = false;

export async function GET(_req: Request, { params }: RouteContext<'/og/[...slug]'>) {
  const { slug } = await params;
  const page = source.getPage(slug.slice(0, -1));
  if (!page) notFound();

  return new ImageResponse(
    // `site` was the fumadocs scaffold default, "My App" — it shipped on every docs
    // OG card. The two colours are overridden for the same reason: fumadocs defaults
    // primaryColor/primaryTextColor to pink (rgb(255,150,255)), which painted a
    // magenta band across every card in a system that is grayscale by rule.
    <DefaultImage
      title={page.data.title}
      description={page.data.description}
      site="Alethia Docs"
      primaryColor={RAMP.gray900}
      primaryTextColor={RAMP.gray400}
    />,
    {
      width: 1200,
      height: 630,
    },
  );
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    lang: page.locale,
    slug: getPageImage(page).segments,
  }));
}
