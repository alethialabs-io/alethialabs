# NRA VAT e-filing file formats: DEKLAR, PRODAGBI, POKUPKI, VIES

Owner: Alethia Labs legal/commercial (board issue #7457)

Effective: 2026-11-24 (every source below was read on that date)

Review cadence: before the first real filing; whenever ППЗДДС is amended (watch for the
euro-wording amendment, §3); whenever the NRA publishes a new version of its program
„Дневници по ЗДДС“.

This is the specification the console's generator (`apps/console/lib/billing/nra/`) is written
against. It records every field of the four files a company registered under чл. 97а ЗДДС files
each month, with its position, width, format and source, and what the company puts in it.

**No lawyer or accountant has reviewed this.** It was written by an agent from the regulation's
text.

- **[C]**: confirmed in a primary source (quoted or cited; URLs in §8).
- **[S]**: an NRA web page or document that is guidance, not the regulation.
- **[I]**: an inference. It can be wrong even when every source under it is right.
- **NOT VERIFIED**: not checked against a primary source. Listed again in §7.

## 1. Where the specification is

- `DEKLAR.TXT`, `PRODAGBI.TXT`, `POKUPKI.TXT`: ППЗДДС **Приложение № 12 към чл. 113, ал. 4**,
  "Параметри, структура и изисквания към файловете на техническия носител …". Last amended by
  ДВ бр. 55/2023, in force 01.07.2023 **[C]**.
- `VIES.TXT`: ППЗДДС **Приложение № 15 към чл. 118, ал. 1**. Last amended by ДВ бр. 11/2021
  **[C]**.
- The consolidated ППЗДДС on lex.bg lists ДВ бр. 54/2024 as its last amendment **[C]**.
- No newer NRA "Описание на файловете" or technical specification exists on nra.bg; the download
  page „ДДС-документи“ lists only the program and its manual **[S]**.
- An NRA opinion of 22.03.2026, on чл. 113, ал. 4 ППЗДДС, says the structure and format of the
  return, the VIES declaration and the two journals do not change for 2026. Only its public
  summary was read (kik-info.com; the full text is paywalled) **[S]**.
- The NRA program „Дневници по ЗДДС“, version **15.01 of 26.01.2026**, generates files for 2026
  and "проверява създадени с други програмни продукти файлове … за съответствие с изискванията на
  утвърдената структура и формат". Its manual's "new in 15.01" names changes for the EU
  small-enterprise scheme and the euro, and no change to the layout **[S]**. The program itself
  (a Windows `.exe`) was not run. **Run the generated files through it before the first upload.**

## 2. Rules common to the three Appendix 12 files [C]

Quoted from Приложение № 12, "Общи изисквания" and "Изисквания към съдържанието на полетата":

- "текстови файлове с кодиране cp-1251/windows-1251".
- "Между отделните полета на един запис във файловете няма разделители."
- Records are separated by "знак за Carriage Return с последващ знак Line Feed".
- "Предвидената дължина (брой знаци) за всяко поле е задължителна. Позициите, които не се
  използват, следва да са запълнени със знак за интервал." An empty field is all spaces.
- "Символен": cp-1251 characters 0x20 to 0xFF, "ляво изравнено", never padded with zeros.
- "Цифров": Arabic digits only, "дясно изравнено". A value may contain "." before the cents and a
  minus sign. "Не се позволява допълване с нули (0) пред дадената сума". Example: "100.00".
- "Дата": "дд/мм/гггг"; the period: "ггггмм".
- Journal records are ordered by "Номер по ред на документа в дневника", starting at 1, rising by
  1, no gaps and no repeats.
- "При положение че за съответния данъчен период в дневника … няма отразени документи,
  файловете "POKUPKI.ТХТ" и/или "PRODAGBI.ТХТ" няма да съдържат нито един запис." A nil month
  writes those two files with zero bytes.
- ППЗДДС чл. 114, ал. 3: the files are filed "и в случаите, когато не съдържат информация".
- "Във всеки отделен запис съдържанието на полетата, описващи стойност, трябва да е с еднакъв
  знак." An empty value field "може да съдържа и стойност нула (0)", e.g. "0.00".

**Positions [I].** The appendix gives each field's width and lists the fields as table rows; it
prints no start positions. With no separators, a field's position is the sum of the widths of the
rows above it, **in the table's row order**. That order is not code order: DEKLAR has 01-20 after
01-01, POKUPKI has 03-02 before 03-01. The generator keeps the printed order. This reading is
standard, but it is the one structural point the NRA program must confirm (§7, item 1).

## 3. Currency: euro [C]

- Приложение № 12 still says "Попълнените стойности трябва да са в български левове", and
  Приложение № 15 says the same **[C]**.
- **Закон за въвеждане на еврото в Република България, чл. 50, ал. 1:** "Паричните стойности в
  данъчните декларации … които се подават за изтекъл данъчен … период, се посочват в паричната
  единица, която е била официална парична единица на Република България в края на данъчния …
  период". From 01.01.2026 that is the euro **[C]**.
- The same law, чл. 11, ал. 2 and ал. 4: leva amounts in existing instruments are read as euro, and
  "позоваванията в правните инструменти на лева без посочване на стойността се считат за
  позовавания на еврото" **[C]**.
- NRA, "Въпроси и отговори за еврото": a December 2025 return is in leva and a January 2026 one in
  euro; "В месечните справки-декларации по ЗДДС принципът е същият" **[S]**.
- A Ministry of Finance draft amendment to ППЗДДС (strategy.bg consultation 12153, 10.02.2026),
  §25: "Навсякъде в приложенията към правилника думите … „български левове“ … се заменят с
  „евро“". No promulgation was found **[S]**. Its §30 rewords the names of DEKLAR 01-18 and
  PRODAGBI 02-18 only, with no change to any width or position.
- **So the generator writes euro and cents**, "123.45", in the fields the appendix says hold leva.

## 4. Field tables

"From" and "To" are 1-based character positions (= byte positions in cp-1251). Names are as
printed in the appendix, shortened with "…" where the appendix's name runs to several lines.

### DEKLAR.TXT: one record [C]

Source: Приложение № 12, "Файлът "DEKLAR.ТХТ" … съдържа единствен запис (ред) със следната
структура". Every value cell is marked "Задължително попълнено: да".

| Field | Name (as printed) | From | To | Width | Format | What the company writes |
|---|---|---:|---:|---:|---|---|
| 00-01 | Идентификационен номер по ДДС на лицето | 1 | 15 | 15 | символен | `BG` + ЕИК, from the input file |
| 00-02 | Наименование на лицето | 16 | 65 | 50 | символен | АЛЕТИЯ ЛАБС ЕДПК |
| 00-03 | Данъчен период | 66 | 71 | 6 | ггггмм | the month |
| 00-04 | Лице, подаващо данните (ЕГН/име) | 72 | 121 | 50 | символен | from the input file |
| 00-05 | Брой документи в дневника за продажби | 122 | 136 | 15 | цифров | PRODAGBI record count |
| 00-06 | Брой документи в дневника за покупки | 137 | 151 | 15 | цифров | POKUPKI record count |
| 01-01 | Общ размер на данъчните основи за облагане с ДДС | 152 | 166 | 15 | сума | Σ 02-10 |
| 01-20 | Всичко начислен ДДС | 167 | 181 | 15 | сума | Σ 02-20 |
| 01-11 | ДО на облагаемите доставки със ставка 20 % … | 182 | 196 | 15 | сума | 0 |
| 01-21 | Начислен ДДС 20 % | 197 | 211 | 15 | сума | 0 |
| 01-12 | ДО на ВОП и на получени доставки по чл. 82, ал. 2 - 6 | 212 | 226 | 15 | сума | Σ 02-12 + Σ 02-26 (the protocols) |
| 01-22 | Начислен данък за ВОП и за получени доставки по чл. 82, ал. 2 - 6 | 227 | 241 | 15 | сума | Σ 02-22 |
| 01-23 | Начислен данък за доставки … за лични нужди | 242 | 256 | 15 | сума | 0 |
| 01-13 | ДО на облагаемите доставки със ставка 9 % | 257 | 271 | 15 | сума | 0 |
| 01-24 | Начислен ДДС 9 % | 272 | 286 | 15 | сума | 0 |
| 01-14 | ДО … със ставка 0 % по глава трета | 287 | 301 | 15 | сума | 0 |
| 01-15 | ДО … 0 % за ВОД на стоки | 302 | 316 | 15 | сума | 0 |
| 01-16 | ДО … 0 % по чл. 140, 146 и чл. 173 | 317 | 331 | 15 | сума | 0 |
| 01-17 | ДО на доставки на услуги по чл. 21, ал. 2 … в друга държава членка | 332 | 346 | 15 | сума | Σ 02-17 (EU B2B sales) |
| 01-18 | ДО на доставки по чл. 69, ал. 2 … | 347 | 361 | 15 | сума | 0 |
| 01-19 | ДО на освободени доставки и освободените ВОП | 362 | 376 | 15 | сума | 0 |
| 01-30 | ДО и данък на получените доставки … без право на данъчен кредит или без данък | 377 | 391 | 15 | сума | Σ 03-30 |
| 01-31 | ДО … с право на пълен данъчен кредит | 392 | 406 | 15 | сума | 0 |
| 01-41 | Начислен ДДС с право на пълен данъчен кредит | 407 | 421 | 15 | сума | 0 |
| 01-32 | ДО … с право на частичен данъчен кредит | 422 | 436 | 15 | сума | 0 |
| 01-42 | Начислен ДДС с право на частичен данъчен кредит | 437 | 451 | 15 | сума | 0 |
| 01-43 | Годишна корекция по чл. 73, ал. 8 (+/-) | 452 | 466 | 15 | сума | 0 |
| 01-33 | Коефициент по чл. 73, ал. 5 | 467 | 470 | 4 | цифров, 0.00 to 1.00 | `0.00` [I] |
| 01-40 | Общо данъчен кредит (кл. 41 + кл. 42 x кл. 33 + кл. 43) | 471 | 485 | 15 | сума | 0 (чл. 70, ал. 4 ЗДДС) |
| 01-50 | ДДС за внасяне (кл. 20 - кл. 40) >= 0 | 486 | 500 | 15 | сума | 01-20 − 01-40 when ≥ 0 |
| 01-60 | ДДС за възстановяване (кл. 20 - кл. 40) < 0 | 501 | 515 | 15 | сума | its absolute value when < 0 |
| 01-70 | Данък за внасяне от кл. 50, приспаднат по реда на чл. 92, ал. 1 | 516 | 530 | 15 | сума | 0 |
| 01-71 | Данък за внасяне от кл. 50, внесен ефективно | 531 | 545 | 15 | сума | = 01-50 [I] |
| 01-80 | ДДС, подлежащ на възстановяване, чл. 92, ал. 1 | 546 | 560 | 15 | сума | 0 |
| 01-81 | ДДС, подлежащ на възстановяване, чл. 92, ал. 3 | 561 | 575 | 15 | сума | 0 |
| 01-82 | ДДС, подлежащ на възстановяване, чл. 92, ал. 4 | 576 | 590 | 15 | сума | 0 |

Record width 590, then CR LF. The acceptance control for each `*` cell is the sum of the named
journal column, "без документи с код за вид документ 11, 12, 13 или 04" (sales) or "11, 12, 13, 94
или 05" (purchases) **[C]**. The generator issues none of those codes.

### PRODAGBI.TXT: one record per sales-journal document [C]

Source: Приложение № 12, "Дневник за продажбите - структура на файловете на техническия носител".

| Field | Name (as printed) | From | To | Width | Format | What the company writes |
|---|---|---:|---:|---:|---|---|
| 02-00 | Идентификационен номер по ДДС на лицето | 1 | 15 | 15 | символен | as 00-01 |
| 02-01 | Данъчен период | 16 | 21 | 6 | ггггмм | as 00-03 |
| 02-02 | Клон/обособено звено | 22 | 25 | 4 | цифров 0-9999 | `0` (head office: "празно … или … нула (0)") |
| 02-03 | Пореден номер на документа в дневника | 26 | 40 | 15 | цифров | 1, 2, 3 … |
| 02-04 | Вид на документа | 41 | 42 | 2 | символен | `01` фактура, `03` кредитно известие, `09` протокол |
| 02-05 | Номер на документа | 43 | 62 | 20 | символен | the ten-digit number |
| 02-06 | Дата на документа | 63 | 72 | 10 | дата | issue date |
| 02-07 | ИН на контрагента (получател) | 73 | 87 | 15 | символен | customer's EU VAT number; for a protocol, the supplier's, or `999999999999999` |
| 02-08 | Име на контрагента (получател) | 88 | 137 | 50 | символен | name, cut to 50 |
| 02-09 | Вид на стоката или обхват и вид на услугата | 138 | 167 | 30 | символен | the service, cut to 30 |
| 02-10 | Общ размер на данъчните основи за облагане с ДДС | 168 | 182 | 15 | сума | "Сума на 02-11, 02-12, 02-13, 02-14, 02-15, 02-16, 02-26" |
| 02-20 | Всичко начислен ДДС | 183 | 197 | 15 | сума | "Сума на 02-21, 02-22, 02-23, 02-24" |
| 02-11 | ДО … ставка 20 % … | 198 | 212 | 15 | сума | 0 |
| 02-21 | Начислен ДДС 20 % | 213 | 227 | 15 | сума | 0 |
| 02-12 | ДО на ВОП | 228 | 242 | 15 | сума | 0 |
| 02-26 | ДО по получените доставки по чл. 82, ал. 2 - 5 ЗДДС | 243 | 257 | 15 | сума | protocol's base |
| 02-22 | Начислен ДДС за ВОП и за получени доставки по чл. 82, ал. 2 - 5 | 258 | 272 | 15 | сума | protocol's tax |
| 02-23 | Начислен данък за … лични нужди | 273 | 287 | 15 | сума | 0 |
| 02-13 | ДО … ставка 9 % | 288 | 302 | 15 | сума | 0 |
| 02-24 | Начислен ДДС 9 % | 303 | 317 | 15 | сума | 0 |
| 02-14 | ДО … 0 % по глава трета | 318 | 332 | 15 | сума | 0 |
| 02-15 | ДО … 0 % на ВОД на стоки | 333 | 347 | 15 | сума | 0 |
| 02-16 | ДО … 0 % по чл. 140, чл. 146, ал. 1 и чл. 173 | 348 | 362 | 15 | сума | 0 |
| 02-17 | ДО на доставки на услуги по чл. 21, ал. 2 … в друга държава членка | 363 | 377 | 15 | сума | EU B2B sale's base (negative for a credit note) |
| 02-18 | ДО на доставки по чл. 69, ал. 2 … | 378 | 392 | 15 | сума | 0 |
| 02-19 | ДО на освободени доставки и освободените ВОП | 393 | 407 | 15 | сума | 0 |
| 02-25 | ДО на доставки като посредник в тристранни операции | 408 | 422 | 15 | сума | 0 |
| 02-27 | Доставка по чл. 163а или внос по чл. 167а | 423 | 424 | 2 | символен | empty |

Record width 424, then CR LF. **02-17 is outside 02-10**: the appendix's formula for 02-10 does not
list it, so an EU B2B sale has 02-10 = 0.00 **[C]**.

### POKUPKI.TXT: one record per purchase-journal document [C]

Source: Приложение № 12, "Дневник за покупките - структура и изисквания към файловете".

| Field | Name (as printed) | From | To | Width | Format | What the company writes |
|---|---|---:|---:|---:|---|---|
| 03-02 | Идентификационен номер по ДДС на лицето | 1 | 15 | 15 | символен | as 00-01 |
| 03-01 | Данъчен период | 16 | 21 | 6 | ггггмм | as 00-03 |
| 03-03 | Клон/обособено звено | 22 | 25 | 4 | цифров | `0` |
| 03-04 | Пореден номер на документа в дневника | 26 | 40 | 15 | цифров | 1, 2, 3 … |
| 03-05 | Вид на документа | 41 | 42 | 2 | символен | `09` протокол |
| 03-06 | Номер на документа | 43 | 62 | 20 | символен | the protocol's number |
| 03-07 | Дата на документа | 63 | 72 | 10 | дата | the protocol's date |
| 03-08 | ИН на контрагента (доставчик) | 73 | 87 | 15 | символен | supplier's EU VAT number, or `999999999999999` |
| 03-09 | Име на контрагента (доставчик) | 88 | 137 | 50 | символен | supplier, cut to 50 |
| 03-10 | Вид на стоката или обхват и вид на услугата | 138 | 167 | 30 | символен | the service, cut to 30 |
| 03-30 | ДО и данък на получените доставки … без право на данъчен кредит или без данък | 168 | 182 | 15 | сума | base + tax |
| 03-31 | ДО … с право на пълен данъчен кредит | 183 | 197 | 15 | сума | 0 |
| 03-41 | ДДС с право на пълен данъчен кредит | 198 | 212 | 15 | сума | 0 |
| 03-32 | ДО … с право на частичен данъчен кредит | 213 | 227 | 15 | сума | 0 |
| 03-42 | ДДС с право на частичен данъчен кредит | 228 | 242 | 15 | сума | 0 |
| 03-43 | Годишна корекция по чл. 73, ал. 8 | 243 | 257 | 15 | сума | 0 |
| 03-44 | ДО при придобиване на стоки от посредник в тристранна операция | 258 | 272 | 15 | сума | 0 |
| 03-45 | Доставка по чл. 163а или внос по чл. 167а | 273 | 274 | 2 | символен | empty |

Record width 274, then CR LF.

### VIES.TXT [C]

Source: Приложение № 15. Fixed width ("полетата във файла са с фиксирана дължина"), cp-1251,
CR LF. Same padding rules as Appendix 12, except that a numeric field "Позволява се допълване с
нули (0)". The generator pads with spaces, which the general rule also allows. Section order:
VHR, VDR, VTR, TTR, VIR… ("вариант 1"; the CHR/COS sections are for call-off stock only).

| Section | Field | Name (as printed) | From | To | Width | Format | What the company writes |
|---|---|---|---:|---:|---:|---|---|
| VHR | 1 | Код на секцията | 1 | 3 | 3 | literal | `VHR` |
| VHR | 2 | Данъчен период | 4 | 10 | 7 | мм/гггг | the month |
| VHR | 3 | Общ брой редове в раздел "В" | 11 | 15 | 5 | цифров | VIR count |
| VDR | 1 | Код на секцията | 1 | 3 | 3 | literal | `VDR` |
| VDR | 2 | ЕГН/ЛНЧ/служебен номер … на лицето, подаващо декларацията | 4 | 18 | 15 | символен | input file |
| VDR | 3 | Трите имена на лицето, подаващо декларацията | 19 | 168 | 150 | символен | input file |
| VDR | 4 | Град от адреса за кореспонденция | 169 | 218 | 50 | символен | input file |
| VDR | 5 | Пощенски код | 219 | 222 | 4 | цифров | input file |
| VDR | 6 | Адрес за кореспонденция (кв., ж.к., ул., №) | 223 | 372 | 150 | символен | input file |
| VDR | 7 | Качество на лицето, подаващо декларацията | 373 | 373 | 1 | символен | `A` пълномощник / `R` представляващ (Latin) |
| VTR | 1 | Код на секцията | 1 | 3 | 3 | literal | `VTR` |
| VTR | 2 | ИН по ДДС на регистрираното лице | 4 | 18 | 15 | символен | as 00-01 |
| VTR | 3 | Име на регистрираното лице | 19 | 168 | 150 | символен | АЛЕТИЯ ЛАБС ЕДПК |
| VTR | 4 | Адрес за кореспонденция | 169 | 368 | 200 | символен | input file |
| TTR | 1 | Код на секцията | 1 | 3 | 3 | literal | `TTR` |
| TTR | 2 | Данъчна основа общо (сума по к3 + к4 + к5) | 4 | 15 | 12 | цифров | Σ VIR 4 + 5 + 6 |
| TTR | 3 | Данъчна основа на ВОД (сума по к3) | 16 | 27 | 12 | цифров | 0 |
| VIR | 1 | Код на секцията | 1 | 3 | 3 | literal | `VIR` |
| VIR | 2 | Номер на ред | 4 | 8 | 5 | цифров | 1, 2, 3 … |
| VIR | 3 | VIN номер на чуждестранния контрагент вкл. знакът на държавата членка | 9 | 23 | 15 | символен | `DE…`; `EL…` for Greece |
| VIR | 4 | Обща стойност на ДО за доставки на стоки | 24 | 35 | 12 | цифров | 0 |
| VIR | 5 | Обща стойност на ДО за тристранни сделки | 36 | 47 | 12 | цифров | 0 |
| VIR | 6 | Обща стойност на ДО за доставени услуги по чл. 21, ал. 2 | 48 | 59 | 12 | цифров | net services to that customer |
| VIR | 7 | Данъчен период, през който данъкът е станал изискуем | 60 | 66 | 7 | мм/гггг | empty when the declaration's own period |

Widths: VHR 15, VDR 373, VTR 368, TTR 27, VIR 66. The VIR table's width column is headed
"Максимална дължина"; the TXT format is stated to be fixed width, so the widths are written as
fixed **[I]**. "За всяка група от секции полетата се попълват задължително с изключение на полето
"Данъчен период" в секции "ВОД" … за редовете, чийто данъчен период съвпада с данъчния период на
декларацията" **[C]**.

## 5. What goes where, for a чл. 97а-only company

- **Sales journal [C].** ППЗДДС чл. 113, ал. 2: a person registered under чл. 97а "отразява в
  дневника за продажбите единствено документите, издадени във връзка с извършените доставки на
  услуги по чл. 21, ал. 2 … на територията на друга държава членка, както и получените доставки
  на услуги, за които данъкът е изискуем от получателя по чл. 82, ал. 2, т. 3 … и извършените
  вътреобщностни придобивания". So:
  - a фактура to a Bulgarian customer (чл. 113, ал. 9) is **not** recorded;
  - a фактура to an EU business with a VAT number of its own member state is recorded (02-17);
  - a фактура to a consumer, or to a customer outside the EU, is **not** recorded [I: they are
    not чл. 21, ал. 2 supplies to another member state];
  - each чл. 117 protocol is recorded (02-26 and 02-22, so also 02-10 and 02-20).
- **Purchase journal [C].** ППЗДДС чл. 113, ал. 3: a чл. 97а person "могат да не изготвят дневник
  за покупките", in which case the file holds "един-единствен запис със стойности "нула" за
  числовите полета и "интервал" за символните полета". The generator does keep the journal: each
  protocol in 03-30, base plus tax, because чл. 70, ал. 4 ЗДДС denies the credit ("Няма право на
  данъчен кредит лице, регистрирано на основание чл. 97а"). Which form to file is an accountant
  question (§6).
- **VIES [C].** ЗДДС чл. 125, ал. 2: filed with the return for a period with чл. 21, ал. 2 services
  to another member state; one VIR line per customer VAT number, net of credit notes.
- **Every month [C].** ЗДДС чл. 125, ал. 1 and ал. 4: a return for every period, also "когато
  регистрираното лице не е извършило или получило доставки". Due by the 14th of the next month
  (чл. 125, ал. 5); tax paid by the same date (чл. 89, ал. 1).
- **The protocol [C].** ЗДДС чл. 117, ал. 1, т. 1 (recipient of a service under чл. 82, ал. 2);
  contents in чл. 117, ал. 2, т. 1-9; issued "не по-късно от 15 дни от датата, на която данъкът е
  станал изискуем" (ал. 3). The generator prints each point and dates each protocol at the earlier
  of 15 days after the tax event and the month's last day.
- **Codes [C].** "Вид на документа": 01 Фактура, 03 Кредитно известие, 09 Протокол или друг
  документ. Counterparty with no EU VAT number: "задължително се попълват с код "999999999999999"
  в случаите, когато контрагентът е чуждестранно лице …, което няма регистрация … или няма ДДС
  номер, с който лицето е регистрирано за целите на ДДС в друга държава членка".

## 6. Questions for the accountant

These are printed in every `nra/SUMMARY.md` until answered and changed in code:

1. Stripe's card-processing fee: exempt (чл. 46, ал. 1, т. 3) or self-charged at 20 %?
2. One protocol per Stripe monthly statement, tax event on the month's last day: right?
3. May the protocols run in their own ten-digit series, or must they share the фактура series?
4. Purchase journal: the full journal (as generated) or the single zero record of чл. 113, ал. 3?
5. DEKLAR 01-33 written as 0.00, and 01-71 equal to 01-50: right for a чл. 97а-only return?
6. Does the NRA accept the files in euro (check with „Дневници по ЗДДС“ v15.01+ before the first
   upload)?

## 7. Not verified

1. **The start positions (§2).** Derived from the table's row order and widths; the appendix
   prints no positions. Confirm with the NRA program before the first upload.
2. **Whether the ППЗДДС euro amendment (draft 12153) was promulgated**, and in which ДВ issue.
   lex.bg and kik-info show none after ДВ бр. 54/2024.
3. **The full text of the NRA opinion of 22.03.2026** on file structure (summary only).
4. **What NRA program v15.01 checks** (rounding, currency) — not run.
5. **The portal e-service page** for the return, journals and VIES: not reached.
6. **01-33 = 0.00 and 01-71 = 01-50** for a return with no credit [I].
7. **VIES amounts with cents.** Appendix 15 allows "." for cents; whether the NRA wants whole
   euro in VIES was not checked.
8. **Signs.** A credit-note record has a negative 02-17 and "0.00" in the other value fields.
   Whether the NRA reads 0.00 as "the same sign" was not checked.
9. **The VDR capacity code.** The appendix's table heading says "Код на латиница" (`A`, `R`); the
   lex.bg text of `А` may be a Cyrillic letter. The generator writes Latin.

## 8. Sources (read 2026-11-24)

| Source | Version | URL |
|---|---|---|
| ППЗДДС: чл. 113, 114, 117, 118; Приложения № 12 и № 15 | lex.bg, last amendment ДВ бр. 54/2024 | https://lex.bg/laws/ldoc/2135534826 |
| ЗДДС: чл. 70, 82, 89, 117, 125 | lex.bg | https://lex.bg/laws/ldoc/2135533201 |
| Закон за въвеждане на еврото в Република България: чл. 11, 12, 13, 50, 51 | lex.bg | https://lex.bg/laws/ldoc/2137244903 |
| NRA, „Въпроси и отговори за еврото“ | as served | https://nra.bg/wps/portal/nra/za-nap/bulgaria_v_eurozonzta/vuprosi-i-otgovori-za-evroto |
| NRA, „ДДС-документи“ (program v15.01, 26.01.2026; user manual) | as served | https://nra.bg/wps/portal/nra/Programni-produkti/DD-dokumenti |
| NRA opinion on file structure, 22.03.2026 (public summary) | kik-info.com | https://kik-info.com/stanovishta-na-nap/671f0055f8990a2d97dd260b6d80aa8b |
| Draft amendment to ППЗДДС, consultation 12153 | strategy.bg, вер. 1.0, 10.02.2026 | https://strategy.bg/download/1317451 |
