// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// #5445 — the paid create-a-team marker is written by the SERVER's create hook, not by the browser.
//
// The hooks with core's capabilities stubbed — what each verdict does to the payload. The same hooks
// as `register(core)` mounts them, driven over HTTP, are in org-slug-hooks.test.ts (it already builds
// that instance), so deleting the composition in index.ts turns a case red there. Core's own rules
// (who owns which setup record) are tested in the console: tests/lib/billing and
// tests/integration/pending-org-setups.test.ts.

import { APIError } from "better-auth/api";
import { describe, expect, it, vi } from "vitest";
import { newOrgSetupHooks } from "./new-org-setup-hooks";

/** core's `newOrgSetup`, stubbed: stamps any marker for the caller, refuses `sub_taken`. */
function stubSetup() {
  return {
    stampMetadata: vi.fn(async (metadata: unknown, userId: string) => {
      if (typeof metadata !== "object" || metadata === null) return null;
      const sub: unknown = Reflect.get(metadata, "newOrgSubscriptionId");
      if (typeof sub !== "string") return null;
      if (sub === "sub_taken") {
        return { refusal: { code: "NEW_ORG_SETUP_ORG_EXISTS", message: "already" } };
      }
      return { metadata: { newOrgSubscriptionId: sub, newOrgCreatedBy: userId } };
    }),
    recordCreated: vi.fn(async () => undefined),
    keepStoredMarker: vi.fn(async (_orgId: string, metadata: unknown) =>
      typeof metadata === "object" && metadata !== null
        ? { metadata: { stored: "marker-kept" } }
        : null,
    ),
  };
}

describe("newOrgSetupHooks — the hooks", () => {
  it("leaves a create with no marker exactly as sent", async () => {
    const setup = stubSetup();
    const hooks = newOrgSetupHooks(setup);
    await expect(
      hooks.beforeCreateOrganization({ organization: { metadata: undefined }, user: { id: "u1" } }),
    ).resolves.toBeUndefined();
  });

  it("refuses a second org for one charge with core's code, as a 400", async () => {
    const hooks = newOrgSetupHooks(stubSetup());
    const err = await hooks
      .beforeCreateOrganization({
        organization: { metadata: { newOrgSubscriptionId: "sub_taken" } },
        user: { id: "u1" },
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(APIError);
    expect(err instanceof APIError ? err.body : null).toMatchObject({
      code: "NEW_ORG_SETUP_ORG_EXISTS",
    });
  });
});
