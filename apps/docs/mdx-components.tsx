// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { Callout } from 'fumadocs-ui/components/callout';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { File, Folder, Files } from 'fumadocs-ui/components/files';
import { Card, Cards } from 'fumadocs-ui/components/card';

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Accordion,
    Accordions,
    Callout,
    Tab,
    Tabs,
    Step,
    Steps,
    File,
    Folder,
    Files,
    Card,
    Cards,
    img: (props: React.ComponentProps<'img'>) => {
      if (typeof props.src === 'string' && props.src.endsWith('.svg')) {
        return <img {...props} style={{ width: '100%', borderRadius: '0.5rem' }} />;
      }
      const DefaultImg = defaultMdxComponents.img;
      return DefaultImg ? <DefaultImg {...props} /> : <img {...props} />;
    },
    ...components,
  };
}
