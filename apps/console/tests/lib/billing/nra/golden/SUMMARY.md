> **DEMO. Built from fixture data. Do not file.**

# ДДС 2026-12: справка-декларация, дневници, VIES

- Filer: BG208913663, registered under чл. 97а ЗДДС only.
- Period: 01.12.2026 to 31.12.2026.
- **VAT payable (cell 50): EUR 10.63.** File and pay by **14.01.2027** (ЗДДС чл. 125, ал. 5; чл. 89, ал. 1).
- Sales journal: 5 line(s). Purchase journal: 3 line(s). VIES: 1 line(s), file VIES.TXT.

## What to check (about 15 minutes)

1. Each protocol below against the supplier's invoice or Stripe's monthly tax statement: supplier, number, date, net amount.
2. Each EU sale against its фактура, and the customer's VAT number in VIES (ec.europa.eu/taxation_customs/vies).
3. The documents left out (below): each reason should be right.
4. Load the files into the NRA program „Дневници по ЗДДС“ (v15.01+) or the portal's check, then upload: DEKLAR.TXT, PRODAGBI.TXT, POKUPKI.TXT, VIES.TXT.
5. Pay EUR 10.63 by 14.01.2027, quoting the return's incoming number.

## Справка-декларация (DEKLAR.TXT)

| Cell | Description | EUR |
|---|---|---:|
| 01-01 | Общ размер на данъчните основи за облагане с ДДС | 53.16 |
| 01-20 | Всичко начислен ДДС | 10.63 |
| 01-11 | Данъчна основа на облагаемите доставки със ставка 20 % | 0.00 |
| 01-21 | Начислен ДДС 20 % | 0.00 |
| 01-12 | Данъчна основа на ВОП и на получени доставки по чл. 82, ал. 2 - 6 от ЗДДС | 53.16 |
| 01-22 | Начислен данък за ВОП и за получени доставки по чл. 82, ал. 2 - 6 от ЗДДС | 10.63 |
| 01-23 | Начислен данък за доставки на стоки и услуги за лични нужди | 0.00 |
| 01-13 | Данъчна основа на облагаемите доставки със ставка 9 % | 0.00 |
| 01-24 | Начислен ДДС 9 % | 0.00 |
| 01-14 | Данъчна основа, подлежаща на облагане със ставка 0 % по глава трета от ЗДДС | 0.00 |
| 01-15 | Данъчна основа на доставките със ставка 0 % за ВОД на стоки | 0.00 |
| 01-16 | Данъчна основа на доставки, подлежаща на облагане с 0 % по чл. 140, 146 и чл. 173 ЗДДС | 0.00 |
| 01-17 | Данъчна основа на доставки на услуги по чл. 21, ал. 2 ЗДДС в друга държава членка | 85.50 |
| 01-18 | Данъчна основа на доставки по чл. 69, ал. 2 ЗДДС | 0.00 |
| 01-19 | Данъчна основа на освободени доставки и освободените ВОП | 0.00 |
| 01-30 | Данъчна основа и данък на получените доставки … без право на данъчен кредит или без данък | 63.79 |
| 01-31 | Данъчна основа на получените доставки … с право на пълен данъчен кредит | 0.00 |
| 01-41 | Начислен ДДС с право на пълен данъчен кредит | 0.00 |
| 01-32 | Данъчна основа на получените доставки … с право на частичен данъчен кредит | 0.00 |
| 01-42 | Начислен ДДС с право на частичен данъчен кредит | 0.00 |
| 01-43 | Годишна корекция по чл. 73, ал. 8 (+/-) ЗДДС | 0.00 |
| 01-40 | Общо данъчен кредит (кл. 41 + кл. 42 x кл. 33 + кл. 43) | 0.00 |
| 01-50 | ДДС за внасяне (кл. 20 - кл. 40) >= 0 | 10.63 |
| 01-60 | ДДС за възстановяване (кл. 20 - кл. 40) < 0 | 0.00 |
| 01-70 | Данък за внасяне от кл. 50, приспаднат по реда на чл. 92, ал. 1 ЗДДС | 0.00 |
| 01-71 | Данък за внасяне от кл. 50, внесен ефективно | 10.63 |
| 01-80 | ДДС, подлежащ на възстановяване, съгласно чл. 92, ал. 1 ЗДДС | 0.00 |
| 01-81 | ДДС, подлежащ на възстановяване, съгласно чл. 92, ал. 3 ЗДДС | 0.00 |
| 01-82 | ДДС, подлежащ на възстановяване, съгласно чл. 92, ал. 4 ЗДДС | 0.00 |
| 01-33 | Коефициент по чл. 73, ал. 5 ЗДДС | 0.00 |

## Дневник за продажбите (PRODAGBI.TXT)

| # | Type | Number | Date | Counterparty | ID | 02-17 | 02-26 | 02-22 |
|---:|---|---|---|---|---|---:|---:|---:|
| 1 | 01 | 0000000102 | 10.12.2026 | Beispiel Software GmbH | DE000000000 | 114.00 | 0.00 | 0.00 |
| 2 | 09 | 0000000002 | 16.12.2026 | Google Cloud EMEA Limited | IE0000001XX | 0.00 | 6.80 | 1.36 |
| 3 | 03 | 0000000103 | 18.12.2026 | Beispiel Software GmbH | DE000000000 | -28.50 | 0.00 | 0.00 |
| 4 | 09 | 0000000003 | 30.12.2026 | Anthropic, PBC | 999999999999999 | 0.00 | 42.17 | 8.43 |
| 5 | 09 | 0000000001 | 31.12.2026 | Stripe Payments Europe, Limited | IE0000000XX | 0.00 | 4.19 | 0.84 |

## Дневник за покупките (POKUPKI.TXT)

| # | Type | Number | Date | Supplier | ID | 03-30 (base + VAT, no credit) |
|---:|---|---|---|---|---|---:|
| 1 | 09 | 0000000001 | 31.12.2026 | Stripe Payments Europe, Limited | IE0000000XX | 5.03 |
| 2 | 09 | 0000000002 | 16.12.2026 | Google Cloud EMEA Limited | IE0000001XX | 8.16 |
| 3 | 09 | 0000000003 | 30.12.2026 | Anthropic, PBC | 999999999999999 | 50.60 |

## Протоколи по чл. 117 ЗДДС

| Number | Supplier | Supplier invoice | Tax event | Base | VAT 20 % |
|---|---|---|---|---:|---:|
| 0000000001 | Stripe Payments Europe, Limited | DEMO-STRIPE-2026-12 / 31.12.2026 | 31.12.2026 | 4.19 | 0.84 |
| 0000000002 | Google Cloud EMEA Limited | DEMO-GW-5550001 / 01.12.2026 | 01.12.2026 | 6.80 | 1.36 |
| 0000000003 | Anthropic, PBC | DEMO-ANT-0042 / 15.12.2026 | 15.12.2026 | 42.17 | 8.43 |

Stripe fees this month: software (Billing, Tax, Radar) EUR 1.24, card processing EUR 2.95 (treated as taxable).

## VIES (VIES.TXT)

| # | VAT number | Services (чл. 21, ал. 2) | Period |
|---:|---|---:|---|
| 1 | DE000000000 | 85.50 | 2026-12 |

## Documents of the month not in the journals

| Number | Kind | Recipient | Country | Base EUR | Why |
|---|---|---|---|---:|---|
| 0000000101 | invoice | Примерна Фирма ЕООД | BG | 49.00 | domestic supply by a person not registered under чл. 96 (чл. 113, ал. 9 ЗДДС); not in the journals (ППЗДДС чл. 113, ал. 2) |

## Notes

- PRODAGBI line 2 (0000000002), 02-09: "Google Workspace Business Starter" written as "Google Workspace Business Star"
- PRODAGBI line 3 (0000000103), 02-09: "Възстановена сума по фактура № 0000000102 / Refund against invoice No. 0000000102" written as "Възстановена сума по фактура №"
- POKUPKI line 2 (0000000002), 03-10: "Google Workspace Business Starter" written as "Google Workspace Business Star"

## Questions for the accountant (open)

1. Stripe's card-processing fee: exempt under чл. 46, ал. 1, т. 3 ЗДДС, or self-charged at 20 % like the Billing fees? The input file's stripe.processingFees records your answer.
2. Is one protocol per Stripe monthly statement right, dated on the last day of the month with the tax event on that day? Or one per fee deduction?
3. Protocol numbering: may the чл. 117 protocols run in their own ten-digit series (as generated), or must they share the фактура series?
4. Purchase journal: ППЗДДС чл. 113, ал. 3 lets a чл. 97а person skip it and file one record of zeros. These files record each protocol in 03-30 instead. Which do you want?
5. DEKLAR 01-33 (coefficient) is written as 0.00 and 01-71 (paid effectively) equal to 01-50. Correct for a чл. 97а-only return?
6. Amounts are in EUR under the Euro Introduction Act, чл. 50, ал. 1, although ППЗДДС Приложение № 12 still says leva. Does the NRA portal accept these files (check them with the NRA's own program, version 15.01 or later, before the first upload)?

Formats and sources: docs/legal/NRA_FILE_FORMATS.md in the Alethia repository.
