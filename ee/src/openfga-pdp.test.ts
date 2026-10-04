// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// #5472: the OpenFGA engine denies an actor who is not an active member of the org (core's
// `lacksActiveMembership`: a non-active row, or no row outside the personal scope). Suspension and
// removal revoke the member's own grant tuples, but team tuples (`team:T#member@user:U`) can outlive
// both, so a store that still says "allowed" through the team must not be asked. The store here
// answers allowed to every allow check, which is what it answers for such a member of a granted team.

import { describe, expect, it, vi } from "vitest";
import { type FgaReader, OpenFgaPdp, type PdpCore } from "./openfga-pdp";

const ORG = "org-1";
const ACTOR = { userId: "user-1", orgId: ORG };

/**
 * An engine over a store that allows every allow relation and no deny relation, with core reporting
 * `lacking` for the actor.
 */
function engine(lacking: boolean) {
  const lacksActiveMembership = vi.fn(async () => lacking);
  const client: FgaReader = {
    check: vi.fn(async ({ relation }) => ({ allowed: !relation.includes("deny") })),
    listObjects: vi.fn(async () => ({ objects: [] })),
  };
  const core: PdpCore = {
    lacksActiveMembership,
    fga: {
      checksFor: () => [{ relation: "project_view", object: `org:${ORG}` }],
      denyChecksFor: () => [],
      enforceDecision: vi.fn(),
      listOrgResourceIds: async () => ["p-1", "p-2"],
    },
  };
  return { pdp: new OpenFgaPdp(core, client), client, lacksActiveMembership };
}

describe("OpenFgaPdp — an actor who is not an active member (#5472)", () => {
  it("denies a non-active or removed member every check and lists nothing, without asking the store; an active member is allowed", async () => {
    const suspended = engine(true);
    expect(await suspended.pdp.can(ACTOR, "view", { type: "project" })).toEqual({
      allowed: false,
      reason: "no_grant",
    });
    expect(await suspended.pdp.listAccessible(ACTOR, "view", "project")).toEqual([]);
    expect(suspended.client.check).not.toHaveBeenCalled();
    expect(suspended.lacksActiveMembership).toHaveBeenCalledWith(ORG, "user-1");

    const active = engine(false);
    expect(await active.pdp.can(ACTOR, "view", { type: "project" })).toEqual({ allowed: true });
    expect(await active.pdp.listAccessible(ACTOR, "view", "project")).toEqual(["p-1", "p-2"]);
  });
});
