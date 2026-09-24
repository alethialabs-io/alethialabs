// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The template catalogue behind the Configure screen's picker (#4110). The starter repositories are
// written down in `apps/docs/content/docs/console/design-project/starter-templates.mdx`; these pin
// the catalogue to the same three names and to the one decision it must not drift from — no
// template provisions a GPU.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_TEMPLATE,
  TEMPLATE_OPTIONS,
  type TemplateId,
  buildCreateInput,
  starterCopyUrl,
  templateOption,
} from "@/components/create-project/templates";
import { DEFAULT_INSTANCE_TYPE, type CloudProviderSlug } from "@/lib/cloud-providers";

const IDS: TemplateId[] = ["standard", "ai", "custom"];
const PROVIDERS: CloudProviderSlug[] = ["aws", "gcp", "azure", "hetzner", "alibaba"];

describe("TEMPLATE_OPTIONS", () => {
  it("has exactly one card per TemplateId, in picker order", () => {
    expect(TEMPLATE_OPTIONS.map((o) => o.id)).toEqual(IDS);
    for (const id of IDS) expect(templateOption(id).id).toBe(id);
    expect(templateOption(DEFAULT_TEMPLATE).id).toBe("standard");
  });

  it("names the starter repositories the docs page names — and none for Custom", () => {
    expect(templateOption("standard").starter?.name).toBe("alethia-starter-apps");
    expect(templateOption("ai").starter?.name).toBe("alethia-starter-ai");
    expect(templateOption("custom").starter).toBeNull();
    const starters = TEMPLATE_OPTIONS.flatMap((o) => (o.starter ? [o.starter] : []));
    expect(starters).toHaveLength(2);
    for (const starter of starters) {
      expect(starter.url).toBe(`https://github.com/alethialabs-io/${starter.name}`);
      expect(starterCopyUrl(starter)).toBe(`${starter.url}/generate`);
    }
  });

  it("promises no GPU anywhere — alethia-starter-ai is CPU-only (#4112)", () => {
    for (const o of TEMPLATE_OPTIONS) {
      const copy = [o.title, o.description, o.nextStep, ...o.features].join(" ");
      expect(copy).not.toMatch(/GPU support|GPU node|Recommended/);
    }
  });
});

describe("buildCreateInput", () => {
  it("uses the provider's default node type on every cloud", () => {
    for (const provider of PROVIDERS) {
      const input = buildCreateInput({
        projectName: "p",
        template: "standard",
        provider,
        cloudIdentityId: "id",
        defaultEnvironment: { name: "production", stage: "production", region: "r" },
      });
      expect(input.cluster.instance_types).toEqual([DEFAULT_INSTANCE_TYPE[provider]]);
    }
  });
});
