# @repo/platform

## 0.4.0

### Minor Changes

- 6a4ad00: Adds `@repo/platform/access-jwt`, the Cloudflare Access token verifier the admin app used, so the console can verify the same token. It also exports `STAFF_ACCESS_TOKEN_HEADER`, the header admin uses to forward the staff member's token on privacy calls (#7951).

## 0.3.0

### Minor Changes

- a185e2c: Add `./paddle` (the Paddle customer-id pattern and hint shared by the staff app and the console), the `paddle_customer_id` column on the console-refs organization billing reference, and the customer-link fields on the platform audit metadata.

## 0.2.0

### Minor Changes

- 6e53e39: Add `./console-refs`: read-only Drizzle references to the console-owned tables the staff app reads (organization, user, member, organization billing, AI usage ledger) and the `billing_plan` / `billing_status` enums. A console test holds them to the console's real schema.

## 0.1.1

### Patch Changes

- 08f55f5: Describe each package on npm instead of the placeholder "Alethia <name>".

## 0.1.0

### Minor Changes

- eaeb9a3: First public release on npm as `@alethialabs/*`.
