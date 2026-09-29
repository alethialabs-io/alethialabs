// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { componentSchemaDocument } from "@/lib/cli/project-components";
import {
  COMPONENT_SCHEMA_GOLDEN,
  REGENERATE_COMMAND,
  renderComponentSchemaGolden,
} from "../../scripts/gen-component-schema";

// packages/core/api/testdata/component_schema.json is read by the Go contract test and by
// cli-contract.test.ts, and both check it against a SCHEMA — neither asks whether it is what
// componentSchemaDocument() actually publishes. So it drifted (#5140): the builder moved its
// nullable encoding from `anyOf` to `type: [X, "null"]`, the golden kept the old encoding and the
// old `version`, and every consumer stayed green. This is the comparison that was missing.

const golden = () => readFileSync(COMPONENT_SCHEMA_GOLDEN, "utf8");

// Each case name carries the fix: vitest/valid-expect forbids a message argument on expect().
describe(`component_schema.json ↔ componentSchemaDocument() — if stale, run ${REGENERATE_COMMAND}`, () => {
  it("holds the builder's document, including its version hash", () => {
    // Semantic first, so a content drift reports the differing field rather than a byte offset.
    // Round-tripped through JSON so the builder's value is compared as it goes over the wire.
    const published: unknown = JSON.parse(
      JSON.stringify(componentSchemaDocument()),
    );
    expect(JSON.parse(golden())).toStrictEqual(published);
  });

  it("carries a version that is the hash of its own kinds", () => {
    // Independent of the builder: a hand edit to `version`, or to `kinds` without the hash,
    // leaves a golden whose ETag no server could have produced.
    const doc: { version: string; kinds: unknown } = JSON.parse(golden());
    const expected = createHash("sha256")
      .update(JSON.stringify(doc.kinds))
      .digest("hex");
    expect(doc.version).toBe(expected);
  });

  it("is byte-identical to the generator's formatted output", async () => {
    // The generator and this test render through one function, so a pass here means the
    // committed bytes are exactly what `gen:component-schema` writes.
    expect(golden()).toBe(await renderComponentSchemaGolden());
  });
});
