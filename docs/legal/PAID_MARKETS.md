# Paid markets — the evidence a country × capacity cell needs before it opens

Owner: Alethia Labs legal/commercial

Effective: 2026-08-24

Review cadence: before any cell is opened, and whenever a tax registration, Stripe account
setting, or published document version changes

This is the operational record behind `PAID_MARKETS` in `packages/legal/src/commerce.ts`.
That constant is **empty**, so no paid conversion can complete in any country, in either
payer capacity. Empty is the correct state today; this document says what would have to be
true for it to stop being.

The same discipline as `GDPR_ACCOUNTABILITY.md` applies. An item marked **NOT ESTABLISHED**
is not a to-do written optimistically — it is a statement that the repository cannot see the
evidence, and it names what would settle it. Nothing here may be marked established because
it is probably fine.

## What a cell is

One entry in `PAID_MARKETS` is a **country × payer capacity** pair, not a country:

```ts
{ country: "BG", capacity: "consumer", evidence: "…" }
```

`consumer` and `organization` are separate cells for the same country because they are
separate legal regimes. Opening `BG/organization` says nothing about `BG/consumer`: the
consumer cell additionally carries pre-contractual information duties, the payment-obligation
button, the 14-day withdrawal right with its proportional accounting, durable confirmation,
and ADR information — all of which exist in code but none of which have been exercised
against a real sale.

## The four conditions

A cell may be added only when all four hold. The `evidence:` string on the cell must say
which, in enough detail that someone can go and check it.

### 1. Tax

**NOT ESTABLISHED — requires a VAT registration decision, recorded here with its number and
effective date.**

`LEGAL_ENTITY.vatRegistered` is `false`. The consequences, which are different per capacity:

- **B2C into the EU.** Distance-supplied digital services are taxed where the *customer* is.
  Without an OSS registration there is no return through which to report VAT collected in
  another member state, and charging it anyway creates a liability with no filing route.
- **B2C in Bulgaria.** Domestic supply. Whether VAT is due at all depends on the registration
  threshold and whether it has been crossed; that is a question about actual turnover, and
  the repository cannot answer it.
- **B2B in the EU.** Reverse charge applies where the customer supplies a valid VAT number,
  but the seller still needs its own registration to invoice under it and to file recapitulative
  statements.

Also required, and separable from the registration itself:

- **NOT ESTABLISHED — requires Stripe Tax to be configured and confirmed computing the correct
  rate for each country and capacity being opened.** `isStripeTaxEnabled()` gates the
  `automatic_tax` parameter today; with it off, invoices carry no tax at all.

### 2. Stripe

**NOT ESTABLISHED — requires confirmation that the account is live rather than test, and that
it is enabled for the payment methods customers in the target country actually use.**

The code path is complete and exercised by tests against a mocked Stripe. What is not
established is anything about the account: live-mode activation, the payment methods enabled,
whether invoicing is configured to produce a compliant document, and whether the statement
descriptor identifies the seller.

### 3. Contractual

Established for English:

- Terms of Service **v2026-08-24**, sealed by content hash and gated by
  `scripts/check-legal-document-hashes.mjs`. Sections 5 and 13 state the paid-market gating,
  the ordinary-cancellation bargain, and the consumer withdrawal right.
- Consumer rights page at `/consumer-rights`, deriving every figure from
  `@repo/legal/commerce` rather than restating it.
- Clickwrap acceptance recorded per user, per document, per version, with the content hash and
  request evidence (`legal_acceptance`).

**NOT ESTABLISHED — requires a decision on whether a Bulgarian-language version of the Terms
and consumer-rights information is required for a `BG/consumer` cell, and if so, a translation
whose version and hash are sealed the same way.** `LEGAL_DOCUMENTS[].locales` currently
declares `en` only for both.

### 4. Commercial rights

Implemented, and tested against the accounting rather than against a real sale:

- 14-day statutory withdrawal, with the CRD art. 14(3) proportional accounting —
  including the case where immediate performance was requested but the proportional charge was
  never acknowledged, in which nothing may be retained.
- Access ends immediately on withdrawal; ordinary cancellation instead runs to the end of the
  paid period with no refund. Recorded as distinct states, because they are distinct facts with
  different money attached.
- The order button carries the CRD art. 8(2) payment-obligation wording for a consumer.
- ADR bodies named for Bulgaria (KZP and the General Conciliation Commission). The repealed EU
  ODR platform is **deliberately not linked**, and a test enforces that.

**NOT ESTABLISHED — requires, per country being opened for `consumer`, confirmation that the
ADR body named in `CONSUMER_ADR` is the correct one for a consumer resident there.** The
current list is correct for a Bulgarian trader; it is not a per-country list.

**NOT ESTABLISHED — requires the durable confirmation to be sent and its content confirmed
against CRD art. 8(7).** The order record captures everything the confirmation must contain;
what is not established is that a message carrying it is actually delivered on a real order.

## Things that are NOT gated on any of this

Stated explicitly, because the gate is easy to over-read:

- **Community is free and unlimited in time.** It is not a trial and it does not expire.
- **The Pro trial requires no card and takes no money**, so it is deliberately outside the
  paid-conversion gate — `tests/billing/trial-invariants.test.ts` fails if it is ever put
  behind it.
- **Cancelling is never refused.** A closed market must not trap a customer in a subscription.

## How a cell is opened

1. Establish the four conditions above and update this document — each `NOT ESTABLISHED` line
   either goes away with its evidence recorded, or the cell does not open.
2. Add the cell to `PAID_MARKETS` with an `evidence:` string naming the registration, the
   Stripe configuration, the document version, and the ADR body.
3. `packages/legal/src/commerce.test.ts` asserts the shape and that the evidence is
   substantive; it deliberately cannot assert that the evidence is *true*. That is what this
   document and a person are for.
