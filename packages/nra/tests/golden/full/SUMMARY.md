# ДДС 2026-12: справка-декларация, дневници, VIES

- Filer: BG208913663, registered under чл. 100, ал. 1 ЗДДС from 01.12.2026.
- Period: 01.12.2026 to 31.12.2026.
- **VAT refundable (cell 60): EUR 10.20**, set off under чл. 92, ал. 1 (cell 80). File by **14.01.2027** (ЗДДС чл. 125, ал. 5).
- Output VAT (cell 20) EUR 59.66; input VAT credit (cell 40) EUR 69.86. Reverse charge on received services nets to 0 (01-22 is also in 01-41).
- Sales journal: 6 line(s). Purchase journal: 3 line(s). Protocols: 2. VIES: 1 line(s), file VIES.TXT.

## What to check (about 15 minutes)

1. Each protocol below against the supplier's invoice: supplier, number, date, net amount, rate.
2. Each sale against its фактура: the cell (20 % / чл. 21, ал. 2 / чл. 69, ал. 2) and, for EU sales, the customer's VAT number in VIES (ec.europa.eu/taxation_customs/vies).
3. Each Bulgarian purchase against its фактура: VAT number, base, VAT, credit right.
4. The documents left out (below): each reason should be right.
5. Load the files into the NRA program „Дневници по ЗДДС“ (v15.01+) or the portal's check, then upload: DEKLAR.TXT, PRODAGBI.TXT, POKUPKI.TXT, VIES.TXT.
6. Nothing to pay this month.

## Справка-декларация (DEKLAR.TXT)

| Cell | Description | EUR |
|---|---|---:|
| 01-01 | Общ размер на данъчните основи за облагане с ДДС | 298.28 |
| 01-20 | Всичко начислен ДДС | 59.66 |
| 01-11 | Данъчна основа на облагаемите доставки със ставка 20 % | 49.00 |
| 01-21 | Начислен ДДС 20 % | 9.80 |
| 01-12 | Данъчна основа на ВОП и на получени доставки по чл. 82, ал. 2 - 6 от ЗДДС | 249.28 |
| 01-22 | Начислен данък за ВОП и за получени доставки по чл. 82, ал. 2 - 6 от ЗДДС | 49.86 |
| 01-23 | Начислен данък за доставки на стоки и услуги за лични нужди | 0.00 |
| 01-13 | Данъчна основа на облагаемите доставки със ставка 9 % | 0.00 |
| 01-24 | Начислен ДДС 9 % | 0.00 |
| 01-14 | Данъчна основа, подлежаща на облагане със ставка 0 % по глава трета от ЗДДС | 0.00 |
| 01-15 | Данъчна основа на доставките със ставка 0 % за ВОД на стоки | 0.00 |
| 01-16 | Данъчна основа на доставки, подлежаща на облагане с 0 % по чл. 140, 146 и чл. 173 ЗДДС | 0.00 |
| 01-17 | Данъчна основа на доставки на услуги по чл. 21, ал. 2 ЗДДС в друга държава членка | 85.50 |
| 01-18 | Данъчна основа на доставки по чл. 69, ал. 2 ЗДДС | 1234.56 |
| 01-19 | Данъчна основа на освободени доставки и освободените ВОП | 0.00 |
| 01-30 | Данъчна основа и данък на получените доставки … без право на данъчен кредит или без данък | 0.00 |
| 01-31 | Данъчна основа на получените доставки … с право на пълен данъчен кредит | 349.28 |
| 01-41 | Начислен ДДС с право на пълен данъчен кредит | 69.86 |
| 01-32 | Данъчна основа на получените доставки … с право на частичен данъчен кредит | 0.00 |
| 01-42 | Начислен ДДС с право на частичен данъчен кредит | 0.00 |
| 01-43 | Годишна корекция по чл. 73, ал. 8 (+/-) ЗДДС | 0.00 |
| 01-33 | Коефициент по чл. 73, ал. 5 ЗДДС | 0.00 |
| 01-40 | Общо данъчен кредит (кл. 41 + кл. 42 x кл. 33 + кл. 43) | 69.86 |
| 01-50 | ДДС за внасяне (кл. 20 - кл. 40) >= 0 | 0.00 |
| 01-60 | ДДС за възстановяване (кл. 20 - кл. 40) < 0 | 10.20 |
| 01-70 | Данък за внасяне от кл. 50, приспаднат по реда на чл. 92, ал. 1 ЗДДС | 0.00 |
| 01-71 | Данък за внасяне от кл. 50, внесен ефективно | 0.00 |
| 01-80 | ДДС, подлежащ на възстановяване, съгласно чл. 92, ал. 1 ЗДДС | 10.20 |
| 01-81 | ДДС, подлежащ на възстановяване, съгласно чл. 92, ал. 3 ЗДДС | 0.00 |
| 01-82 | ДДС, подлежащ на възстановяване, съгласно чл. 92, ал. 4 ЗДДС | 0.00 |

## Дневник за продажбите (PRODAGBI.TXT)

| # | Type | Number | Date | Counterparty | ID | Cells |
|---:|---|---|---|---|---|---|
| 1 | 01 | 0000000101 | 03.12.2026 | Примерна Фирма ЕООД | BG000000000 | 02-10 49.00, 02-11 49.00, 02-20 9.80, 02-21 9.80 |
| 2 | 01 | 0000000102 | 10.12.2026 | Beispiel Software GmbH | DE000000000 | 02-17 114.00 |
| 3 | 03 | 0000000103 | 18.12.2026 | Beispiel Software GmbH | DE000000000 | 02-17 -28.50 |
| 4 | 09 | 0000000001 | 30.12.2026 | Anthropic, PBC | 999999999999999 | 02-10 47.50, 02-20 9.50, 02-22 9.50, 02-26 47.50 |
| 5 | 01 | 0000000104 | 31.12.2026 | Paddle.com Market Ltd | 999999999999999 | 02-18 1234.56 |
| 6 | 09 | 0000000002 | 31.12.2026 | Amazon Web Services EMEA SARL | LU00000000 | 02-10 201.78, 02-20 40.36, 02-22 40.36, 02-26 201.78 |

## Дневник за покупките (POKUPKI.TXT)

| # | Type | Number | Date | Supplier | ID | Cells |
|---:|---|---|---|---|---|---|
| 1 | 01 | 0000004711 | 10.12.2026 | Примерен Счетоводител ООД | BG000000001 | 03-31 100.00, 03-41 20.00 |
| 2 | 09 | 0000000001 | 30.12.2026 | Anthropic, PBC | 999999999999999 | 03-31 47.50, 03-41 9.50 |
| 3 | 09 | 0000000002 | 31.12.2026 | Amazon Web Services EMEA SARL | LU00000000 | 03-31 201.78, 03-41 40.36 |

## Протоколи по чл. 117 ЗДДС

| Number | Date | Supplier | Supplier invoice | Tax event | Base | VAT 20 % |
|---|---|---|---|---|---:|---:|
| 0000000001 | 30.12.2026 | Anthropic, PBC | ANT-0042 / 15.12.2026 | 15.12.2026 | 47.50 | 9.50 |
| 0000000002 | 31.12.2026 | Amazon Web Services EMEA SARL | AWS-0001 / 31.12.2026 | 31.12.2026 | 201.78 | 40.36 |

## VIES (VIES.TXT)

| # | VAT number | Services (чл. 21, ал. 2) | Period |
|---:|---|---:|---|
| 1 | DE000000000 | 85.50 | 2026-12 |

## Documents of the month not in the journals

| Side | Number | Date | Counterparty | Country | Net EUR | Why |
|---|---|---|---|---|---:|---|
| received | STRIPE-2026-12 | 31.12.2026 | Stripe Payments Europe, Limited | IE | 2.95 | treated as outside the journals (an exempt or out-of-scope supply received) |

## Notes

- PRODAGBI line 3 (0000000103), 02-09: "Възстановена сума по фактура № 0000000102" written as "Възстановена сума по фактура №"

## Questions for the accountant (open)

1. Paddle: the monthly фактура to Paddle.com Market Ltd (UK) / Paddle.com Inc. (US) is recorded in 02-18 (чл. 69, ал. 2) with 02-07 = 999999999999999. Right cell, and is that the counterparty code you want (rather than their own UK/US numbers)?
2. Stripe's card-processing fee (and other exempt financial services received): left out of both journals (the default here), or recorded in 03-30 as a supply received „без данък“?
3. Protocols: are the чл. 117 protocols recorded in 02-26 / 02-22 (services received under чл. 82, ал. 2) and in 03-31 / 03-41 with full credit (чл. 69, ал. 1, т. 2), each protocol in its own ten-digit series? Or must they share the фактура series?
4. DEKLAR: 01-33 = 0.00 and 01-42 = 01-43 = 0 (no exempt supplies, so no partial credit); 01-80 = 01-60 when the month is refundable (set-off under чл. 92, ал. 1); 01-70 = earlier refundable VAT set off this month, from the input file. Correct?
5. A domestic customer with no VAT number: 02-07 = its ЕИК (or ЕГН), and 999999999999999 for a person with neither. Is that what you file?
6. Documents dated before the registration took effect are left out of the journals. Any purchase that qualifies for credit under чл. 74 ЗДДС (assets still held) you want to add by hand?
7. Amounts are in EUR under the Euro Introduction Act, чл. 50, ал. 1, although ППЗДДС Приложение № 12 still says leva. Please check the files with the NRA program „Дневници по ЗДДС“ (v15.01 or later) before the first upload.

Formats and sources: docs/legal/NRA_FILE_FORMATS.md in the Alethia repository.
