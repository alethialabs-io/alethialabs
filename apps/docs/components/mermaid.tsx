// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

'use client';

import { useEffect, useId, useState } from 'react';
import { useTheme } from 'next-themes';
import { RAMP, RAMP_THEME } from '@repo/brand/ramp-srgb';

/**
 * Grayscale Mermaid theme variables, derived from the real ink ramp.
 *
 * Mermaid cannot read CSS custom properties, so the values must be literals —
 * but they were previously hand-transcribed, and had drifted onto Tailwind's
 * zinc scale (`#18181b`, `#d4d4d8`, `#a1a1aa`), which is not the Alethia ramp
 * and carries a slight blue cast. Building them from `RAMP` keeps 60 literals
 * in sync with `packages/brand/src/tokens.css` by construction.
 */
function themeVariables(dark: boolean) {
  const c = RAMP_THEME[dark ? 'dark' : 'light'];
  return {
    background: 'transparent',
    // nodes
    primaryColor: c.surface,
    primaryBorderColor: c.borderStrong,
    primaryTextColor: c.textPrimary,
    secondaryColor: c.surfaceMuted,
    secondaryBorderColor: c.border,
    secondaryTextColor: c.textSecondary,
    tertiaryColor: c.background,
    tertiaryBorderColor: c.border,
    tertiaryTextColor: c.textSecondary,
    lineColor: dark ? RAMP.gray600 : RAMP.gray500,
    textColor: c.textSecondary,
    mainBkg: c.surface,
    nodeBorder: c.borderStrong,
    clusterBkg: c.background,
    clusterBorder: c.border,
    edgeLabelBackground: c.surface,
    titleColor: c.textPrimary,
    // sequence
    actorBkg: c.surface,
    actorBorder: c.borderStrong,
    actorTextColor: c.textPrimary,
    signalColor: c.textSecondary,
    signalTextColor: c.textSecondary,
    labelBoxBkgColor: c.surfaceMuted,
    labelBoxBorderColor: c.border,
    labelTextColor: c.textSecondary,
    noteBkgColor: c.surfaceMuted,
    noteBorderColor: c.borderStrong,
    noteTextColor: c.textPrimary,
    activationBkgColor: c.border,
    sequenceNumberColor: c.surface,
  };
}

/**
 * Renders a Mermaid diagram client-side with the locked grayscale Alethia theme,
 * re-rendering when the site theme (light/dark) changes. Used by fenced
 * ```mermaid code blocks (mapped in mdx-components) and directly in MDX.
 */
export function Mermaid({ chart }: { chart: string }) {
  const id = useId();
  const [svg, setSvg] = useState('');
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    let active = true;

    async function render() {
      const { default: mermaid } = await import('mermaid');
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        fontFamily: 'inherit',
        theme: 'base',
        themeVariables: themeVariables(resolvedTheme === 'dark'),
        flowchart: { curve: 'basis', useMaxWidth: true, padding: 12 },
        sequence: { useMaxWidth: true, mirrorActors: false },
      });

      try {
        const renderId = `mmd-${id.replace(/[^a-zA-Z0-9]/g, '')}`;
        const { svg: out } = await mermaid.render(renderId, chart.trim());
        if (active) setSvg(out);
      } catch (err) {
        console.error('[mermaid] render failed', err);
      }
    }

    void render();
    return () => {
      active = false;
    };
  }, [chart, id, resolvedTheme]);

  return (
    <div
      className="my-6 flex justify-center overflow-x-auto rounded-lg border bg-fd-card p-4 [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
