# Console QA — coverage matrix

Domains × spec files × tests × personas. Authored live against the :3100 QA console.

| Spec file | tests | fixme (bugs) | skip | personas |
|---|--:|--:|--:|---|
| `agent-usage-activity.negative.spec.ts` | 8 | 0 | 2 | owner,team |
| `agent-usage-activity.spec.ts` | 21 | 0 | 0 | owner,team |
| `alerts.negative.spec.ts` | 5 | 0 | 1 | member,owner,team |
| `alerts.spec.ts` | 28 | 0 | 0 | team |
| `billing.negative.spec.ts` | 4 | 0 | 0 | owner,team |
| `billing.spec.ts` | 22 | 0 | 0 | owner,team |
| `connectors.negative.spec.ts` | 4 | 1 | 3 | member,owner |
| `connectors.spec.ts` | 22 | 1 | 0 | owner |
| `cross-cutting.negative.spec.ts` | 2 | 0 | 0 | owner |
| `cross-cutting.spec.ts` | 7 | 0 | 0 | owner |
| `deploy-jobs.negative.spec.ts` | 5 | 0 | 0 | owner |
| `deploy-jobs.spec.ts` | 21 | 0 | 0 | owner |
| `navigation-shell.negative.spec.ts` | 5 | 0 | 0 | owner |
| `navigation-shell.spec.ts` | 33 | 0 | 0 | owner |
| `onboarding.negative.spec.ts` | 7 | 0 | 0 | owner |
| `onboarding.spec.ts` | 22 | 0 | 1 | owner |
| `projects.negative.spec.ts` | 8 | 0 | 0 | owner |
| `projects.spec.ts` | 20 | 0 | 0 | owner |
| `rbac.negative.spec.ts` | 4 | 0 | 2 | member |
| `rbac.spec.ts` | 40 | 1 | 0 | owner,team |
| `runners.negative.spec.ts` | 3 | 0 | 0 | owner,team |
| `runners.spec.ts` | 16 | 0 | 0 | team |
| **total** | **307** | **3** | **9** | |

## Coverage notes

- **Personas:** `owner` (Hobby), `team` (Pro trial) are live. `member` (invited reduced-perms) is **not yet built** — RBAC permission-denied negatives are authored but `test.skip(!process.env.HAVE_MEMBER)`. Adding the member persona (invite → accept flow in global-setup) unblocks them.
- **fixme** counts = tests written against the CORRECT behavior that currently fail on a confirmed app bug (see findings.md); un-fixme once the bug is fixed.
- **Deploy depth:** stops at job QUEUED / uses `helpers/seed.ts` for post-deploy UI (clusters/drift). No real tofu/cloud/runner execution. A live runner in the shared env claims seeded QUEUED jobs, so active-job tests seed PROCESSING.
- **Not covered (by design):** real Stripe payment, real cloud credential verification, real email delivery, real provisioning.
