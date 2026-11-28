---
"@repo/platform": minor
---

Adds `@repo/platform/access-jwt`, the Cloudflare Access token verifier the admin app used, so the console can verify the same token. It also exports `STAFF_ACCESS_TOKEN_HEADER`, the header admin uses to forward the staff member's token on privacy calls (#7951).
