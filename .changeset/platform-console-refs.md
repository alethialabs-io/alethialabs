---
"@repo/platform": minor
---

Add `./console-refs`: read-only Drizzle references to the console-owned tables the staff app reads (organization, user, member, organization billing, AI usage ledger) and the `billing_plan` / `billing_status` enums. A console test holds them to the console's real schema.
