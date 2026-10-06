// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { settableProviderConfigKnobs } from "@/lib/cli/provider-config-knobs";
import {
  PROVIDER_CONFIG_KEYS_FILE,
  REGENERATE_COMMAND,
  providerConfigKeys,
} from "../../../scripts/gen-provider-config-keys";

// apps/cli/cmd/provider_config_keys.json is the allow-list `alethia export` writes provider_config
// keys through (#5531). A key it names that the console no longer calls settable — a knob that became
// a credential, a template variable that was removed — is a key the export would write into a file
// people commit. That direction fails here.
//
// The other direction (a knob that BECAME settable and is missing from the file) deliberately does
// not: the export then leaves the key out, names it in the file's header, and apply keeps the stored
// value. Gating it would make every template lane that adds a knob regenerate a file under apps/cli.

const fileSchema = z.object({
  generatedBy: z.string(),
  keys: z.record(z.string(), z.record(z.string(), z.array(z.string()))),
});

/** The committed allow-list, parsed. */
const committed = () =>
  fileSchema.parse(JSON.parse(readFileSync(PROVIDER_CONFIG_KEYS_FILE, "utf8")));

describe(`provider_config_keys.json ↔ settableProviderConfigKnobs — if stale, run ${REGENERATE_COMMAND}`, () => {
  it("names no key the console does not call settable", () => {
    const notSettable: string[] = [];
    for (const [cloud, kinds] of Object.entries(committed().keys)) {
      for (const [kind, keys] of Object.entries(kinds)) {
        const settable = new Set(
          settableProviderConfigKnobs(cloud, kind).map((k) => k.name),
        );
        for (const key of keys) {
          if (!settable.has(key)) notSettable.push(`${cloud} ${kind} ${key}`);
        }
      }
    }
    expect(notSettable).toEqual([]);
  });

  it("is not empty — an empty allow-list would make every export leave every knob out", () => {
    // Non-vacuity for the test above: a file with no keys passes "names nothing unsettable".
    const total = Object.values(committed().keys)
      .flatMap((kinds) => Object.values(kinds))
      .reduce((n, keys) => n + keys.length, 0);
    expect(total).toBeGreaterThan(0);
  });

  it("the generator excludes credential knobs and reserved keys", () => {
    // The generator's own output, so a regression in providerConfigKeys() is caught before it is
    // committed: no key named like a credential, no alethia_* key, no secret's own value.
    const all = Object.values(providerConfigKeys()).flatMap((kinds) =>
      Object.values(kinds).flat(),
    );
    expect(all.length).toBeGreaterThan(0);
    expect(
      all.filter(
        (k) =>
          k.startsWith("alethia_") ||
          k === "value" ||
          /(^|_)(password|token|credentials?|secret_key|private_key|api_key)(_|$)/.test(k),
      ),
    ).toEqual([]);
  });
});
