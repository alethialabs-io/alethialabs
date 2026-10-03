// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// #5445 — a reserved slug is refused by the SERVER, not only by the console's forms.
//
// Two layers, because each answers a different question:
//   1. the hooks themselves, driven with core's REAL rule (the vitest `@` alias resolves
//      lib/routing.ts, which is pure), so "reserved" means exactly what the console means by it;
//   2. a real better-auth instance on its in-memory adapter, with the organization plugin carrying
//      these hooks, called the way a client that skipped the form would call it. That is the claim
//      the issue makes — a direct `/organization/create` with slug `docs` succeeded — and on the old
//      plugin config (no hooks) the create in (2) RESOLVES with an org named `docs`.

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError } from "better-auth/api";
import { organization } from "better-auth/plugins/organization";
import { describe, expect, it } from "vitest";
import {
  ORG_SLUG_RESERVED_CODE,
  ORG_SLUG_RESERVED_MESSAGE,
  reservedOrgSlugRefusal,
} from "@/lib/routing";
import { orgSlugHooks } from "./org-slug-hooks";

const hooks = orgSlugHooks(reservedOrgSlugRefusal);

/** The APIError a hook threw, or a failure naming what it did instead. */
async function refusalOf(run: () => Promise<unknown>): Promise<APIError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof APIError) return err;
    throw err;
  }
  throw new Error("expected the hook to refuse, and it returned");
}

describe("orgSlugHooks — the rule", () => {
  it.each(["docs", "login", "api", "~", "Docs", " pricing "])(
    "refuses %j on create AND on update, with core's code and sentence",
    async (slug) => {
      for (const hook of [hooks.beforeCreateOrganization, hooks.beforeUpdateOrganization]) {
        const err = await refusalOf(() => hook({ organization: { slug } }));
        expect(err.statusCode).toBe(400);
        expect(err.body).toMatchObject({
          code: ORG_SLUG_RESERVED_CODE,
          message: ORG_SLUG_RESERVED_MESSAGE,
        });
      }
    },
  );

  it("lets an ordinary slug through, and an update that does not touch the slug", async () => {
    await expect(
      hooks.beforeCreateOrganization({ organization: { slug: "acme" } }),
    ).resolves.toBeUndefined();
    await expect(
      hooks.beforeUpdateOrganization({ organization: { slug: "acme-2" } }),
    ).resolves.toBeUndefined();
    await expect(hooks.beforeUpdateOrganization({ organization: {} })).resolves.toBeUndefined();
  });
});

describe("orgSlugHooks — inside better-auth's own endpoints", () => {
  /** A real better-auth with the organization plugin carrying these hooks, and a signed-in user. */
  async function setup() {
    const db: Record<string, Record<string, unknown>[]> = {
      user: [],
      session: [],
      account: [],
      verification: [],
      organization: [],
      member: [],
      invitation: [],
    };
    const auth = betterAuth({
      secret: "test-secret-test-secret-test-secret-0123",
      baseURL: "http://localhost:3000",
      database: memoryAdapter(db),
      emailAndPassword: { enabled: true },
      plugins: [organization({ organizationHooks: { ...hooks } })],
    });
    const res = await auth.api.signUpEmail({
      body: { email: "owner@example.com", password: "a-long-password-1", name: "Owner" },
      returnHeaders: true,
    });
    const cookie = res.headers.get("set-cookie") ?? "";
    const headers = new Headers({ cookie: cookie.split(";")[0] ?? "" });
    return { auth, db, headers };
  }

  it("refuses a direct create with a reserved slug, and stores no organization", async () => {
    const { auth, db, headers } = await setup();
    const err = await refusalOf(() =>
      auth.api.createOrganization({ body: { name: "Docs", slug: "docs" }, headers }),
    );
    expect(err.body).toMatchObject({ code: ORG_SLUG_RESERVED_CODE });
    expect(db.organization).toHaveLength(0);
  });

  it("refuses a direct rename onto a reserved slug, and keeps the old one", async () => {
    const { auth, db, headers } = await setup();
    const org = await auth.api.createOrganization({
      body: { name: "Acme", slug: "acme" },
      headers,
    });
    expect(org?.slug).toBe("acme");

    const err = await refusalOf(() =>
      auth.api.updateOrganization({
        body: { organizationId: org?.id, data: { slug: "pricing" } },
        headers,
      }),
    );
    expect(err.body).toMatchObject({ code: ORG_SLUG_RESERVED_CODE });
    expect(db.organization[0]).toMatchObject({ slug: "acme" });
  });
});
