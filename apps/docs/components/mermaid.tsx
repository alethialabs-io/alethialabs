// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

'use client';

import { useEffect, useId, useState } from 'react';
import { useTheme } from 'next-themes';

/**
 * Grayscale Mermaid theme variables. No hue, ever — matches the Alethia Labs
 * design language (neutral ink ramp, hairline borders, mono edge labels).
 * `fontFamily: inherit` pulls the page's Geist stack into the diagram.
 */
const GRAYSCALE_THEME = {
  light: {
    background: 'transparent',
    primaryColor: '#ffffff', // node fill (surface)
    primaryBorderColor: '#d4d4d8', // hairline border (border-strong)
    primaryTextColor: '#18181b', // text-primary
    secondaryColor: '#f4f4f5', // surface-sunken
    secondaryBorderColor: '#e4e4e7',
    secondaryTextColor: '#3f3f46',
    tertiaryColor: '#fafafa',
    tertiaryBorderColor: '#e4e4e7',
    tertiaryTextColor: '#52525b',
    lineColor: '#8a8a8d', // gray-500 edges
    textColor: '#3f3f46',
    mainBkg: '#ffffff',
    nodeBorder: '#d4d4d8',
    clusterBkg: '#fafafa',
    clusterBorder: '#e4e4e7',
    edgeLabelBackground: '#ffffff',
    titleColor: '#18181b',
    // sequence
    actorBkg: '#ffffff',
    actorBorder: '#d4d4d8',
    actorTextColor: '#18181b',
    signalColor: '#52525b',
    signalTextColor: '#3f3f46',
    labelBoxBkgColor: '#fafafa',
    labelBoxBorderColor: '#e4e4e7',
    labelTextColor: '#3f3f46',
    noteBkgColor: '#f4f4f5',
    noteBorderColor: '#d4d4d8',
    noteTextColor: '#18181b',
    activationBkgColor: '#e4e4e7',
    sequenceNumberColor: '#ffffff',
  },
  dark: {
    background: 'transparent',
    primaryColor: '#18181b', // surface
    primaryBorderColor: '#3f3f46',
    primaryTextColor: '#fafafa',
    secondaryColor: '#0f0f11',
    secondaryBorderColor: '#2c2c30',
    secondaryTextColor: '#a1a1aa',
    tertiaryColor: '#202023',
    tertiaryBorderColor: '#2c2c30',
    tertiaryTextColor: '#a1a1aa',
    lineColor: '#71717a',
    textColor: '#d4d4d8',
    mainBkg: '#18181b',
    nodeBorder: '#3f3f46',
    clusterBkg: '#141416',
    clusterBorder: '#2c2c30',
    edgeLabelBackground: '#18181b',
    titleColor: '#fafafa',
    actorBkg: '#18181b',
    actorBorder: '#3f3f46',
    actorTextColor: '#fafafa',
    signalColor: '#a1a1aa',
    signalTextColor: '#d4d4d8',
    labelBoxBkgColor: '#202023',
    labelBoxBorderColor: '#2c2c30',
    labelTextColor: '#d4d4d8',
    noteBkgColor: '#202023',
    noteBorderColor: '#3f3f46',
    noteTextColor: '#fafafa',
    activationBkgColor: '#2c2c30',
    sequenceNumberColor: '#18181b',
  },
} as const;

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
      const mode = resolvedTheme === 'dark' ? 'dark' : 'light';
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        fontFamily: 'inherit',
        theme: 'base',
        themeVariables: GRAYSCALE_THEME[mode],
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
