# Tax and market preconditions — what must be true before a `PAID_MARKETS` cell opens

Owner: Alethia Labs legal/commercial

Effective: 2026-11-17 (every source below was read on that date)

Review cadence: before any cell is opened; on any change to the Bulgarian VAT Act, to the
company's registration status, or to the list of vendors the company buys from; and at the
latest on 2027-01-04, before the paid go / no-go.

This is the research record for board unit LEG-L6. It answers one question: **for each market
and each kind of buyer, what does tax and consumer law require before the product takes money,
and who has to do it.** It changes no code and opens no market. `PAID_MARKETS` in
`packages/legal/src/commerce.ts` stays empty; `docs/legal/PAID_MARKETS.md` stays the operational
checklist, and this document is the evidence behind its condition 1 (Tax) and part of its
condition 4 (Commercial rights).

**No lawyer or accountant has reviewed this.** It was written by an agent from the statute
texts. Read it with that in mind:

- **[C]** marks a statement **confirmed from a primary source**: the article is quoted or cited
  and the URL is in section 8.
- **[I]** marks an **inference**: a conclusion drawn by applying a confirmed rule to this
  company's facts, or by combining two confirmed rules. An inference can be wrong even when
  every source under it is right.
- **[S]** marks a figure taken from **Stripe's documentation**, which describes the law of
  another jurisdiction but is not that jurisdiction's law.
- Anything that could not be confirmed is in section 7, not in the body.

Bulgarian quotations are the original text. The English after each is this document's own
translation, not an official one.

Terms used below: "the VAT Act" is the Bulgarian Закон за данък върху добавената стойност
(ЗДДС); "the Directive" is Council Directive 2006/112/EC; "the Implementing Regulation" is
Council Implementing Regulation (EU) No 282/2011; "the CRD" is Directive 2011/83/EU; "NRA" is
the Bulgarian National Revenue Agency (НАП).

---

## 1. Verdict

### 1.1 The statement that was to be checked

`decisions-2026-11-17.md` records, as the orchestrator's belief from memory: *a Bulgarian company
needs the limited Art. 97a registration before its first sale to a business in another EU member
state.*

**It is correct, and it is incomplete in a way that matters more than the statement itself.**

1. **Correct [C].** Art. 97a(2) of the VAT Act makes a company established in Bulgaria subject to
   registration when it supplies services whose place of supply is another member state and on
   which the recipient owes the tax. Art. 97a(4) puts the filing deadline **seven days before**
   the tax on that supply becomes chargeable. Section 2.1 quotes both.
2. **Incomplete [C].** Art. 97a(1) imposes the same registration on a company that **receives**
   taxable services from a supplier not established in Bulgaria. That trigger does not depend on
   selling anything. Whether it has already been met is a question about the company's purchase
   invoices, which this repository cannot see. Section 2.1 states the test; section 6 lists it as
   the maintainer's first check.
3. **Narrower than "a business" [I].** For VAT the dividing line is not "organization versus
   consumer" as `PayerCapacity` draws it. It is whether the customer is a taxable person, and the
   Implementing Regulation lets a seller of electronically supplied services treat any EU customer
   who has **not communicated a VAT identification number** as a non-taxable person. An EU
   organization that gives no VAT number can therefore be handled under the consumer-side VAT
   rules of section 2.2.

### 1.2 Market × buyer

"May open" below means **tax law does not require a registration first**. It does not mean the
cell may open: conditions 2 to 4 of `docs/legal/PAID_MARKETS.md` (live Stripe account, sealed
terms, consumer duties) still apply to every row.

| Market | Buyer | Tax verdict | What is needed first | Who |
|---|---|---|---|---|
| Bulgaria | Business or individual | **May open with no registration [C]** | A running total of turnover with place of supply in Bulgaria against the EUR 51,130 threshold | Agent builds the counter; maintainer files if it is crossed |
| Other EU member states | Business that gives a VIES-valid VAT number | **Needs the Art. 97a registration first [C]** | Application filed at least 7 days before the first charge; NRA acts within 3 days | **Maintainer only** |
| Other EU member states | Business that gives no VAT number | **May open with no registration [I]**, treated for VAT as the row below | Checkout records that no VAT number was given | Agent |
| Other EU member states | Individual (consumer) | **May open with no registration while cross-border EU sales to non-taxable persons stay at or under EUR 10,000 a calendar year [C]** | A running total against EUR 10,000; a decided action for the sale that crosses it; the consumer duties of section 2.5, including the online withdrawal function | Agent builds; maintainer registers for OSS when crossed |
| United States | Business or individual | **May open with no registration [C for Bulgarian VAT; S for state thresholds]** | Per-state monitoring; the lowest thresholds are USD 100,000 or 200 transactions in a state | Agent configures monitoring; maintainer registers in a state when crossed |
| Canada | Business or individual | **Not as one country-wide cell [S]** | Federal threshold is CAD 30,000 over 12 months, but Stripe documents Saskatchewan and Manitoba at **1 transaction** and British Columbia at CAD 10,000 | Decision needed: see section 5.5 |
| Mexico, and any other country | Either | **Not researched. Do not open.** | Section 7 | — |

### 1.3 What this means for 2027-01-08

**[I]** No statutory lead time in this document blocks the date. The only registration that must
exist before a first sale is Art. 97a, and it needs the application filed seven days ahead and
gives the NRA three days to act. Every other cell either needs no registration or needs one only
after a threshold that a launch will not reach in its first week.

**[I]** The date is at risk from one thing in this document: the decision "no VAT registration
now" cannot stand together with opening a cell for EU businesses that give a VAT number. Either
that registration is filed in December, or those cells stay closed on launch day and the rest
open. Both are legal. Which one is "paid readiness" is the maintainer's to define.

---

## 2. The six questions

### 2.1 Art. 97a: is the claim right, what triggers it, when, and what it obliges

**The supplying trigger [C].** VAT Act Art. 97a(2):

> На регистрация по закона подлежи всяко данъчно задължено лице по чл. 3, ал. 1, 5 и 6,
> установено на територията на страната, което предоставя услуги по чл. 21, ал. 2 с място на
> изпълнение на територията на друга държава членка, за които се дължи данък по доставката от
> получателя - данъчно задължено лице или данъчно незадължено юридическо лице, регистрирано за
> целите на ДДС в тази държава членка.

Translation: every taxable person established in Bulgaria that supplies services under Art. 21(2)
with place of supply in another member state, on which the tax is owed by the recipient (a
taxable person, or a non-taxable legal person registered for VAT in that member state), is
subject to registration.

Art. 21(2), which it refers to **[C]**:

> Мястото на изпълнение при доставка на услуга, когато получателят е данъчно задължено лице, е
> мястото, където получателят е установил независимата си икономическа дейност.

Translation: where the recipient is a taxable person, the place of supply of a service is where
the recipient has established its business. This is Art. 44 of the Directive, and Art. 196 of the
Directive makes that recipient liable for the VAT **[C]**.

**The receiving trigger [C].** VAT Act Art. 97a(1):

> На регистрация по този закон подлежи всяко данъчно задължено лице по чл. 3, ал. 1, 5 и 6,
> което получава услуги с място на изпълнение на територията на страната, които са облагаеми и
> за които данъкът е изискуем от получателя по чл. 82, ал. 2.

Translation: every taxable person that receives services with place of supply in Bulgaria, which
are taxable and on which the tax is chargeable to the recipient under Art. 82(2), is subject to
registration.

Art. 82(2), point 3 **[C]** makes the recipient liable when "доставчикът е данъчно задължено
лице, което не е установено на територията на страната" (the supplier is a taxable person not
established in Bulgaria) and the supply is a service to a taxable person. **The test is "not
established in Bulgaria", not "established in another member state"**: a supplier in the United
States meets it exactly as a supplier in Ireland or Germany does **[C on the text; I on the
application to a given vendor]**.

**[I]** Applied to this company: a subscription to a foreign cloud, software or developer-tool
vendor is a service received by a taxable person from a supplier not established in Bulgaria, so
its place of supply under Art. 21(2) is Bulgaria and Art. 82(2) makes the company liable. Unless
the service is exempt, that meets Art. 97a(1). It does so whether or not the vendor's invoice
shows VAT, and whether or not the company has sold anything. Whether the company is already a
"taxable person" before its first sale turns on Art. 3(1) ("всяко лице, което извършва независима
икономическа дейност, без значение от целите и резултатите от нея": any person carrying out an
independent economic activity, whatever its purpose or results) **[C on the text; I that
pre-revenue preparation counts]**.

**One registration covers both [C].** Art. 97a(3): "Данъчно задължено лице, регистрирано на
основание ал. 1, се смята за регистрирано и по ал. 2 и обратното." (A person registered under
paragraph 1 is deemed registered under paragraph 2 as well, and the reverse.)

**When the application must be filed [C].** Art. 97a(4):

> За лицата по ал. 1 и 2 възниква задължение за подаване на заявление за регистрация по този
> закон не по-късно от 7 дни преди датата, на която данъкът за доставката става изискуем
> (авансово плащане или данъчно събитие), като данъчната основа на получената услуга подлежи на
> облагане с данък.

Translation: the obligation to file arises no later than 7 days before the date on which the tax
on the supply becomes chargeable (advance payment or chargeable event).

**[I]** A subscription charged to a card at the start of the period is an advance payment, so
the date that counts is the date of the first charge to the first such customer. "Before the
first sale" in the decisions file is therefore right, and the precise form is **seven days
before the first charge**.

**What the registration obliges [C unless marked].**

- A VAT identification number with the prefix "BG" is assigned (Art. 94(2)).
- A VAT return for **every** monthly tax period, with the purchase and sales ledgers, by the
  14th of the following month, including periods with nothing to report (Art. 125(1), (3), (4),
  (5); the period is the calendar month under Art. 87(2)).
- A VIES declaration with the return for every period in which services under Art. 21(2) were
  supplied to another member state (Art. 125(2)).
- Self-assessment of Bulgarian VAT on each service received from a supplier not established in
  Bulgaria, documented by a protocol the recipient issues (Art. 117(1), point 1; Art. 86), at the
  standard rate of 20 per cent (Art. 66(1)).
- **No deduction of that VAT.** Art. 70(4): "Няма право на данъчен кредит лице, регистрирано на
  основание чл. 97а" (a person registered under Art. 97a has no right to input tax credit).
  **[I]** For a company whose costs are largely foreign cloud and software services this is a
  real cost of about one fifth of those invoices, not a formality.
- Invoices to EU businesses carry no VAT amount and no rate, and state "обратно начисляване"
  (reverse charge) with the ground for it (Art. 114(4)).

**What it does not oblige or allow [C unless marked].**

- It does not let the company show VAT on any invoice. Art. 113(9): persons "регистрирани на
  основание чл. 97а, ал. 1 и 2 ... нямат право да посочват данъка в издаваните от тях фактури"
  (registered under Art. 97a(1) and (2) have no right to show the tax on the invoices they
  issue). **[I]** So it does not turn domestic sales, or EU consumer sales under the EUR 10,000
  threshold, into sales with VAT on them.
- It is not the general registration. If the grounds for mandatory registration under Art. 96
  arise later, the company registers again on that ground and in that deadline (Art. 97a(5)).
- It can be ended: Art. 108(1), point 4 gives a ground for voluntary deregistration when, on the
  date of the application, no ground for mandatory registration exists.
- It is not triggered by sales to US or Canadian customers: Art. 97a(2) names only "друга държава
  членка" (another member state).

**The consequence of not filing in time [C].** Art. 102(1) lets the NRA register the company on
its own initiative; Art. 102(3) then treats the tax on received reverse-charge services as owed
from the date the company should have been registered; Art. 178(1) sets a sanction for a missed
application "в размер от 500 до 5000 лв." (the text on lex.bg still states it in leva).

**The mandatory-registration threshold [C].** Art. 96(1), as amended with effect from
2026-01-01, requires registration "когато годишният му оборот в страната, определен по реда на
чл. 168в, надвиши националния праг от 51 130 евро" (when its annual turnover in the country,
determined under Art. 168c, exceeds the national threshold of **EUR 51,130**). The currency is
the euro. The NRA's own registration page states the same figure **[C]**.

Three details of that threshold change how it is counted **[C]**:

- It is measured over the **calendar year**, not a rolling twelve months, and only over supplies
  "с място на изпълнение на територията на страната" (with place of supply in Bulgaria)
  (Art. 168c(1)).
- The application is due within 7 days of exceeding it (Art. 96(6), point 1), and the
  registration date is the day after it is exceeded (Art. 103, point 1).
- **[I]** Sales to EU businesses with a VAT number, and all sales to the United States and
  Canada, have their place of supply outside Bulgaria and so do not count. Sales to Bulgarian
  customers and EU consumer sales under the EUR 10,000 threshold have their place of supply in
  Bulgaria and do count.

### 2.2 Electronically supplied services to EU consumers: the EUR 10,000 threshold

**Is the product an electronically supplied service? [C on the definition; I on the
classification.]** Implementing Regulation Art. 7(1): such services are those "delivered over the
Internet or an electronic network and the nature of which renders their supply essentially
automated and involving minimal human intervention, and impossible to ensure in the absence of
information technology." Annex II of the Directive lists "Website supply, web-hosting, distance
maintenance of programmes and equipment" and "supply of software and updating thereof". A hosted
control plane sold by subscription fits that description. No ruling confirms it for this product.

**The general rule [C].** VAT Act Art. 21(6) (Directive Art. 58): the place of supply of such a
service to a non-taxable person "е мястото, където това лице е установено, има постоянен адрес
или обичайно пребиваване" (is where that person is established, has a permanent address or
usually resides).

**The exception for small cross-border sellers [C].** VAT Act Art. 20b(1) (Directive Art. 59c)
switches that rule off when all three hold: the supplier is established in only one member state;
the services go to non-taxable persons in other member states; and

> общата стойност без ДДС на доставките по т. 2 не надвишава през текущата календарна година и
> не е надвишавала през предходната календарна година 10 000 евро

Translation: the total value, net of VAT, of those supplies does not exceed EUR 10,000 in the
current calendar year and did not in the preceding one. Art. 20b(2): "Мястото на изпълнение на
доставката по ал. 1 е в държавата членка, в която е установен доставчикът." (The place of supply
is then the supplier's member state.)

**What that means below the threshold [C for each rule; I for the chain].** The sale to a German
or French consumer is, for VAT, a Bulgarian domestic sale. Art. 82(1) makes tax chargeable only
from "регистрирано по този закон лице" (a person registered under the Act), so an unregistered
company charges no VAT on it. The sale counts toward the EUR 51,130 threshold of section 2.1.
No OSS registration is needed, and none is possible on these facts except by opting in under
Art. 20b(4), which binds for two calendar years.

**The threshold is EU-wide and single [C].** It is one total across all other member states, not
EUR 10,000 per country, and it counts only supplies to non-taxable persons. **[I]** Sales to EU
businesses under reverse charge, and all sales to non-EU customers, are outside it.

**What changes above it [C].** Art. 20b(3): "Мястото на изпълнение на доставката, с която се
надхвърли посоченият праг ... се определя по чл. 20, ал. 1 и чл. 21, ал. 6." The place of supply
moves to the customer's member state **starting with the sale that crosses the threshold**, not
from the next year. From that sale on, the VAT of the customer's member state is due at that
state's rate. The company then has three routes:

1. **The Union One Stop Shop** (VAT Act Art. 156; Directive Art. 369a to 369k). One registration
   in Bulgaria, one quarterly return covering every member state of consumption, due by the end
   of the month after the quarter (Art. 159(1) and (4)). The Act provides for a person registered
   **only** under Art. 156 (Art. 70(4), Art. 113(9), Art. 125(14)), so OSS does not require the
   general Art. 96 registration first. Section 2.6 has the lead time.
2. **A VAT registration in each member state of consumption** [C that the Act names it as an
   alternative, Art. 20b(5); not otherwise examined].
3. **The EU small-enterprise scheme** (VAT Act Art. 168e to 168k; Directive Art. 284), in force
   in Bulgaria since 2026-01-01, under which a small enterprise can be exempt in other member
   states while its Union turnover stays at or under EUR 100,000 and under each state's own
   threshold. Named in Art. 20b(5) as a route. Not analysed here; section 7.

**Who counts as a consumer for this purpose [C].** Implementing Regulation Art. 18(2), second
subparagraph:

> However, irrespective of information to the contrary, the supplier of telecommunications,
> broadcasting or electronically supplied services may regard a customer established within the
> Community as a non-taxable person as long as that customer has not communicated his individual
> VAT identification number to him.

**Where the customer is [C].** Implementing Regulation Art. 24b: for a seller whose such supplies
do not exceed EUR 100,000 in the current and preceding calendar year, the customer's location is
presumed from "one item of evidence provided by a person involved in the supply of the services
other than the supplier or the customer", from the list in Art. 24f (billing address, IP address,
bank details and others). **[I]** The country of the card or bank account, as reported by the
payment processor, is such an item.

### 2.3 Sales to the United States and Canada

**Bulgarian VAT [C].** A sale to a business: Art. 21(2) puts the place of supply where the
recipient is established. A sale to an individual: Art. 21(6) puts it where the individual
resides, and the Art. 20b threshold does not reach it, because that article covers only customers
"в държави членки" (in member states). In both cases the place of supply is outside Bulgaria, and
Art. 86(3) says "Не се начислява данък ... при доставка с място на изпълнение извън територията
на страната" (no tax is charged on a supply with place of supply outside the country).

**[I]** These sales therefore need no Bulgarian registration, do not count toward the EUR 51,130
threshold (Art. 168c(1) counts only supplies with place of supply in Bulgaria), do not count
toward the EUR 10,000 threshold, and do not trigger Art. 97a(2). The invoicing rules of the VAT
Act still apply to them (Art. 111a(3)).

**United States [S].** There is no single threshold. Each state sets its own, and a seller with
no physical presence must register in a state only after crossing that state's economic-nexus
threshold. Stripe's per-state pages, read 2026-11-17, give:

| Threshold as Stripe states it | Jurisdictions |
|---|---|
| USD 100,000 **or** 200 transactions | Arkansas, District of Columbia, Georgia, Hawaii, Maine, Maryland, Michigan, Minnesota, Nebraska, Nevada, New Jersey, North Carolina, Ohio, Puerto Rico, Rhode Island, Vermont, Virginia, West Virginia, Wyoming |
| USD 100,000 **and** 200 transactions (both) | Connecticut |
| USD 100,000 | Alaska (local taxes only), Arizona, Colorado, Florida, Idaho, Illinois, Indiana, Iowa, Kansas, Kentucky, Louisiana, Massachusetts, Missouri, New Mexico, North Dakota, Oklahoma, Pennsylvania, South Carolina, South Dakota, Tennessee, Utah, Washington, Wisconsin |
| USD 250,000 | Alabama, Mississippi |
| USD 500,000 | California, Texas |
| USD 500,000 **and** 100 transactions (both) | New York |
| No general state sales tax | Delaware, Montana, New Hampshire, Oregon |

Three cautions on that table:

- **[S]** The measuring period differs by state (previous calendar year, previous or current
  calendar year, prior twelve months, last four quarters), and so does what is counted: several
  states count only sales of tangible personal property, which a subscription is not.
- **[I]** The transaction-count thresholds are the ones a subscription business reaches first.
  A monthly plan produces twelve transactions a year per customer, so about seventeen customers
  in one such state reach 200 transactions long before USD 100,000.
- Whether the product is **taxable at all** in each state is a separate question from the
  threshold, and it is not established here (section 7). Crossing a threshold in a state that
  does not tax the product can still create a duty to register and file.

**Canada [C for federal; S for provincial].** The Canada Revenue Agency states that a
non-resident vendor's obligation to register "generally depends on whether your threshold amount
of applicable revenues exceeds $30,000 CAD over any 12-month period", counting supplies to
"Canadian consumers and other Canadian entities who are not registered under the normal GST/HST
regime". Registration is under the simplified GST/HST regime, under which the registrant "would
not be allowed to claim input tax credits". Supplies to GST/HST-registered businesses that give
their number are outside the threshold.

Stripe's pages add the provincial layer, read 2026-11-17 **[S]**:

| Province | Tax | Threshold as Stripe states it |
|---|---|---|
| Federal (all provinces) | GST/HST | CAD 30,000 per rolling 12 months |
| Quebec | QST | CAD 30,000 per rolling year by quarter |
| British Columbia | PST | CAD 10,000 per rolling 12 months |
| Saskatchewan | PST | **1 transaction** |
| Manitoba | RST | **1 transaction** |

**[I]** If the Saskatchewan and Manitoba rows are right, a single sale to a customer in either
province creates a provincial registration duty. Neither was confirmed against the provincial
statute (section 7). Until one is, a Canada cell that cannot exclude those two provinces should
be treated as needing a registration from its first sale there.

### 2.4 Invoicing for a non-registered company, and what Stripe can and cannot do

**Is an invoice required? [C]** Art. 113(1): "Всяко данъчно задължено лице - доставчик, е длъжно
да издаде фактура за извършената от него доставка на стока или услуга или при получаване на
авансово плащане преди това". The duty attaches to every taxable person, registered or not.
Art. 113(3), point 1 allows no invoice "за доставки, по които получателят е данъчно незадължено
физическо лице" (for supplies where the recipient is a non-taxable natural person). The invoice
is due within 5 days of the chargeable event or of the advance payment (Art. 113(4)).

**Which country's invoicing rules apply? [C]** Art. 111a: Bulgarian rules govern supplies with
place of supply in Bulgaria; supplies to another member state under reverse charge made by a
supplier established in Bulgaria; and supplies with place of supply in a third country made by a
supplier established in Bulgaria. **[I]** That is every sale this company makes while it has no
foreign registration.

**What the invoice must contain [C].** Art. 114(1), in summary: the document's name; "пореден
десетразряден номер, съдържащ само арабски цифри" (a sequential **ten-digit number containing
only Arabic digits**); date of issue; supplier's name and address; the supplier's VAT number, or
for an unregistered supplier "номера по чл. 84 от Данъчно-осигурителния процесуален кодекс" (its
identification number under the Tax and Social Insurance Procedure Code; **[I]** for a company that
is its commercial-register number); recipient's name and address; the recipient's VAT or other identification
number; type of service; the date of the chargeable event or of the payment; unit price and
taxable amount; the rate, and where no tax is charged "основанието за неначисляване на данък"
(the ground for not charging it); the tax amount; the amount payable.

Further rules that bear on this company **[C]**:

- An unregistered company may not show VAT on an invoice (Art. 113(9)).
- Where the recipient owes the tax, the invoice omits rate and amount and states "обратно
  начисляване" with its ground (Art. 114(4)).
- Amounts may be in any currency provided the taxable amount and tax are also stated in euro
  (Art. 114(5)).
- Electronic invoices need the recipient's written or tacit acceptance (Art. 114(9)).
- Invoices are kept, with proof of their authenticity and integrity, for the period in
  Art. 121(1): five years after the limitation period of the liability they evidence.

**What Stripe does [C from Stripe's documentation].**

- It calculates and collects tax only where a registration has been added: "Without a
  registration in the customer's location, the calculation returns zero tax."
- It monitors thresholds and warns, but only "for sales outside of the country your business is
  based in". **[I]** It will not watch the Bulgarian EUR 51,130 threshold.
- It offers a "small seller" setting that tracks total EU sales against EUR 10,000.
- It validates EU VAT numbers against VIES, with a limit it states itself: "This process only
  validates whether or not the tax ID is valid—you still need to verify the customer's name and
  address". Implementing Regulation Art. 18(1) asks for confirmation of the number **and** of
  the associated name and address **[C]**.
- It applies reverse charge "based on the presence of a tax ID and the jurisdictions involved".

**What Stripe does not do [C from Stripe's documentation unless marked].**

- It does not register the company anywhere by default, and "Registration and filing are
  separate services." It does not file a Bulgarian VAT return or VIES declaration **[I]**.
- It numbers invoices as a prefix of 1 to 12 letters or digits, a hyphen and a sequence, for
  example `MYSHOP-1203`. **[I]** That is not a ten-digit number of Arabic digits only, so a
  Stripe invoice does not, on its own, satisfy Art. 114(1), point 2. A Bulgarian-format invoice
  has to be produced as well, from the same data.
- It is the payment processor, not the seller. The company remains the supplier for every
  obligation in this document **[I]**.

### 2.5 Consumer-law duties when selling to individuals in the EU

Stated briefly; the mechanics already live in `packages/legal/src/commerce.ts` and are audited by
LEG-L1.

**The right [C].** CRD Art. 9(1): "the consumer shall have a period of 14 days to withdraw from a
distance or off-premises contract, without giving any reason". The Bulgarian Consumer Protection
Act (ЗЗП) Art. 50 gives the same 14 days, running for a service contract from its conclusion.

**How a subscription service lawfully starts at once [C].** CRD Art. 8(8): where the consumer
wants performance to begin during the withdrawal period, "the trader shall require that the
consumer make an express request and request the consumer to acknowledge that, once the contract
has been fully performed by the trader, the consumer will no longer have the right of
withdrawal." CRD Art. 14(3): a consumer who then withdraws "shall pay to the trader an amount
which is in proportion to what has been provided". CRD Art. 14(4)(a): the consumer bears no cost
where that express request was not made or the withdrawal information was not given.

**[I]** A subscription is not "fully performed" inside 14 days, so the Art. 16(a) exception does
not end the right. The lawful pattern is the one the code already models: an express request
plus acknowledgement at purchase, withdrawal still available for 14 days, and a proportional
charge for the days supplied. The exception in Art. 16(m), for digital content with immediate
loss of the right, is written for "digital content which is not supplied on a tangible medium";
the CRD defines a "digital service" separately (Art. 2(16)), and a hosted service is the latter.

**The online withdrawal function, in force now [C].** Directive (EU) 2023/2673 inserted Art. 11a
into the CRD, applied by member states "from 19 June 2026":

> For distance contracts concluded by the means of an online interface, the trader shall ensure
> that the consumer can also withdraw from the contract by using a withdrawal function. The
> withdrawal function shall be labelled with the words "withdraw from contract here" or an
> unambiguous corresponding formulation in an easily legible way. The withdrawal function shall
> be continuously available throughout the withdrawal period.

It must lead to a confirmation step labelled "confirm withdrawal", and the trader must
acknowledge receipt on a durable medium. Bulgaria has transposed it as ЗЗП Art. 52a, "в сила от
24.09.2026 г.", with the labels "откажете се от договора тук" and "потвърждавам отказа" and an
acknowledgement "не по-късно от края на работния ден" (no later than the end of the working
day). Whether the console has this function is a question for LEG-L1; `docs/legal/PAID_MARKETS.md`
does not list it.

### 2.6 Lead times

| Registration | Filing deadline for the company | Deadline for the authority | Takes effect | Source |
|---|---|---|---|---|
| VAT Act Art. 97a | 7 days before the first chargeable date | "в тридневен срок от подаване на заявлението" (within 3 days of the application) | On service of the registration act | Art. 97a(4), Art. 101(8), Art. 103 point 3 **[C]** |
| VAT Act Art. 100(1), voluntary general registration | None | "в срок 7 дни от подаване на заявлението" (within 7 days) | On service of the act | Art. 101(6), Art. 103 point 3 **[C]** |
| VAT Act Art. 96(1), mandatory at EUR 51,130 | Within 7 days of exceeding | 7 days | The day after the threshold is exceeded | Art. 96(6), Art. 101(6), Art. 103 point 1 **[C]** |
| Union OSS, VAT Act Art. 156 | By the 10th of the month after the first sale it must cover | 7 days to check, then 7 days to issue the act | First day of the next quarter, or the date of the first sale if filed by that 10th | Art. 156(4), (5), (7); Implementing Regulation Art. 57d **[C]** |
| EU small-enterprise scheme, Art. 168g | Before using it | "до 35 работни дни" (up to 35 working days) | Not read | Art. 168g(8) **[C]** |
| Canada, simplified GST/HST | On the day the threshold is exceeded | Not stated on the pages read | The day the threshold is exceeded | CRA **[C]**; processing time in section 7 |
| US states | After crossing a state's threshold | Not established | Not established | Section 7 |

Two practical conditions for the Bulgarian filings **[C]**: the OSS application is filed
electronically "с квалифициран електронен подпис" (with a qualified electronic signature) and
names a euro bank account "в българска банка или клон на чуждестранна банка в Република
България" (Art. 156(2) and (3)); the Art. 97a application may be filed electronically or at the
NRA office by the company's legal representative (Art. 101(2) and (3)).

**[I]** Working back from 2027-01-08 for the Art. 97a route: the registration act must be
served, and seven days must have passed since filing, before the first EU business is charged.
An application filed by **2026-12-18** leaves three weeks for the three-day statutory period,
the holidays, and one round of corrections. An application filed after **2027-01-01** cannot
satisfy the seven-day rule for a charge on 2027-01-08.

---

## 3. Preconditions for each `PAID_MARKETS` cell

These are the tax and consumer-law preconditions only. Each is in addition to conditions 2 and 3
of `docs/legal/PAID_MARKETS.md`. "Agent" means an agent can build or verify it; "Maintainer"
means it needs the company's legal representative.

### 3.1 Every cell

1. **Maintainer.** The Art. 97a(1) question is answered from the purchase invoices (section 6,
   item 1), because the answer decides whether a registration is already due irrespective of any
   cell.
2. **Agent.** The product is recorded in Stripe with a product tax code for a hosted software
   service, and the code is named in the cell's evidence string.
3. **Agent.** A Bulgarian-format invoice (Art. 114(1)) is produced for every sale to a business,
   with a ten-digit numeric sequence, the company's register number, and the ground for charging
   no tax. Which ground applies differs by row and is given below.
4. **Agent.** A running total of turnover with place of supply in Bulgaria for the calendar year
   is visible to the maintainer, with a warning well short of EUR 51,130.
5. **Maintainer.** A decision, recorded here, on what the product does on the day a threshold is
   crossed: stop selling into that cell, or register. A cell must not open on the assumption that
   somebody will notice.

### 3.2 `BG` / `organization` and `BG` / `consumer`

- No registration **[C]**. Ground for no tax on the invoice: the supplier is not registered under
  the VAT Act (Art. 113(9)).
- `BG/consumer` additionally: the open item in `docs/legal/PAID_MARKETS.md` on a
  Bulgarian-language version of the terms, and the withdrawal function of ЗЗП Art. 52a.

### 3.3 Other member states / `organization`, customer gives a VAT number

- **Maintainer.** Art. 97a registration served, with the BG VAT number recorded in
  `packages/legal/src/entity.ts` by a later unit.
- **Agent.** Checkout collects the VAT number, validates it against VIES, and keeps the
  validation result with the name and address returned, because Implementing Regulation
  Art. 18(1) asks for all three.
- **Agent.** The invoice states reverse charge and its ground (Art. 114(4)); the sale is listed
  for the monthly VIES declaration (Art. 125(2)).
- **Maintainer.** Monthly VAT returns from the registration date, nil or not, and the
  self-assessed VAT on foreign services.

### 3.4 Other member states / `organization`, customer gives no VAT number

- No registration, on the Art. 18(2) presumption **[I]**. The sale is counted in the EUR 10,000
  total of 3.5.
- **Agent.** The order records that no VAT number was communicated. That record is the evidence
  the presumption rests on.

### 3.5 Other member states / `consumer`

- No registration while the total stays at or under EUR 10,000 in the current calendar year and
  did not exceed it in the previous one **[C]**.
- **Agent.** A running total of cross-border EU sales to customers with no VAT number, net of
  VAT, across all member states together, with the decision of 3.1 item 5 wired to it. The sale
  that crosses the threshold is itself taxed in the customer's member state, so the control has
  to act **before** that sale, not after it.
- **Agent.** One item of location evidence from the payment processor kept per sale
  (Implementing Regulation Art. 24b).
- **Agent.** The consumer duties of section 2.5, including the withdrawal function.
- Still open in `docs/legal/PAID_MARKETS.md` and not answered here: the correct dispute body and
  any language requirement for each member state (section 7).
- **Maintainer, when the threshold is crossed.** OSS registration under Art. 156, filed by the
  10th of the following month, which needs a qualified electronic signature and a euro account
  at a bank in Bulgaria.

### 3.6 `US` / `organization` and `US` / `consumer`

- No Bulgarian registration **[C]**. No US registration until a state threshold is crossed
  **[S]**.
- **Agent.** Stripe's threshold monitoring is on, and the customer's state is captured for every
  US sale, since a sale with no state cannot be attributed to a threshold.
- **Agent.** A count of transactions per state as well as revenue per state, because the
  200-transaction thresholds arrive first.
- **Maintainer.** A decision on the first state crossed: register there, or stop selling into
  that state. `PAID_MARKETS` is keyed by country, so a per-state stop is not expressible today
  (section 5.5).
- Not established and needed before a `US/consumer` cell: the US consumer rules on automatic
  renewal and cancellation (section 7).

### 3.7 `CA` / `organization` and `CA` / `consumer`

- No Bulgarian registration **[C]**. Federally, no Canadian registration until CAD 30,000 of
  supplies to non-registered recipients over 12 months **[C]**.
- **Blocking, not established.** Stripe states a threshold of one transaction for Saskatchewan
  and Manitoba. Either that is confirmed wrong for this product from the provincial source, or
  the cell needs a way to refuse those provinces, or it opens with the two provincial
  registrations in place.
- **Agent.** The customer's province is captured for every Canadian sale.

---

## 4. What only the maintainer can do

Nothing in this list can be done, drafted to completion, or signed by an agent.

1. **Read the company's purchase invoices** and decide whether Art. 97a(1) already applies
   (section 6).
2. **File the Art. 97a application** with the NRA, as the company's legal representative
   (Art. 101(2), point 2), electronically or in person. The attachments are set by the
   implementing rules, which were not read (section 7).
3. **File the monthly returns and VIES declarations** that follow, or appoint someone who will.
4. **Decide between Art. 97a and the voluntary general registration under Art. 100(1).** They
   lead to different products: the general registration restores the deduction of input VAT, and
   in exchange puts 20 per cent VAT on Bulgarian sales and on EU consumer sales under the
   threshold **[I]**. This is a pricing decision as much as a tax one.
5. **Obtain a qualified electronic signature** and hold a euro account at a bank in Bulgaria,
   both needed for OSS and usable for the rest.
6. **Register for OSS** when the EUR 10,000 total is crossed, and for the general registration
   when EUR 51,130 is crossed.
7. **Register in a US state or a Canadian jurisdiction** when its threshold is crossed.
8. **Activate the live Stripe account** and enter the registrations into Stripe Tax.
9. **Open any cell.** The switch stays the maintainer's by the decision of 2026-11-17.

---

## 5. Consequences for the decisions of 2026-11-17

Stated as what the sources imply, not as a recommendation to change a decision.

### 5.1 "No VAT registration now" and "EU businesses" do not fit together

**[C]** A cell for a business in another member state that gives a VAT number cannot open before
the Art. 97a registration. "Register when I get a customer" is too late by the statute's own
terms, because the application is due seven days **before** that customer is charged.

### 5.2 Most of the decided market can open without any registration

**[I]** Bulgaria, EU individuals up to EUR 10,000 a year in total, EU organizations that give no
VAT number, and the United States all open, as far as tax goes, with the company unregistered.

### 5.3 The first threshold a launch will meet is EUR 10,000, not EUR 51,130

**[I]** At the catalog prices in `packages/plan-catalog/src/index.ts` (EUR 18 and EUR 90 a
month), EUR 10,000 of cross-border consumer sales in a calendar year is about 46 subscribers on
the lower plan for a full year, or about 9 on the higher one. That is the event to plan the OSS
filing around.

### 5.4 The trial and the free plan

**[I]** Neither takes money, so neither is a supply for consideration, and neither triggers
anything in this document. The decision to put the trial behind the same gate as paid is a
product decision, not a tax requirement.

### 5.5 Thresholds below the country level

**[I]** US states and Canadian provinces each carry their own threshold, and two provinces may
carry a threshold of one sale. A cell keyed by country can open a country or close it; it cannot
close one state. If per-state control is wanted, that is a change to the shape of
`PaidMarketCell`, outside this unit.

### 5.6 "North America" needs a list

**[I]** This document covers the United States and Canada. Mexico was not researched. Until it
is, "North America" should be read as those two.

---

## 6. The first check, before anything else

**Question.** Has the company, since it was entered in the register on 2026-08-11, received a
taxable service from a supplier not established in Bulgaria?

**How to answer it.** List every paid invoice from a vendor whose address is outside Bulgaria.
For each: was it a service, and is that service of a kind that is exempt (for example, payment
processing may fall under the financial-services exemption; that was not checked)?

**If yes for any one of them [C on the rule; I on the outcome].** Art. 97a(1) applied seven days
before the tax on that service became chargeable. The single Art. 97a registration that follows
also covers sales to EU businesses (Art. 97a(3)), so the registration needed for the EU business
cells and the registration the purchases require are one filing.

**If no.** The registration is needed only for the EU business cells, on the timetable of
section 2.6.

---

## 7. Not established

Each item names what would settle it. None of these may be treated as fine because it is
probably fine.

**Bulgarian tax**

- **NOT ESTABLISHED — the documents attached to an Art. 97a application and the form number.**
  Art. 101(4) refers to the implementing rules (ППЗДДС), which were not read. Settled by reading
  ППЗДДС or the NRA service page.
- **NOT ESTABLISHED — how the registration act is served and how long service takes in
  practice.** Art. 103 dates the registration from service; the three days in Art. 101(8) are for
  performing the registration. Settled by the Tax and Social Insurance Procedure Code and by the
  NRA.
- **NOT ESTABLISHED — whether a person registered under Art. 97a must charge VAT on its own
  Bulgarian sales.** Art. 113(9) forbids showing the tax on its invoices and Art. 70(4) denies
  the deduction; this document infers from those that it does not charge. No source read says so
  in one sentence. Settled by an NRA written opinion.
- **NOT ESTABLISHED — which of the company's vendors supply an exempt service.** Settled invoice
  by invoice.
- **NOT ESTABLISHED — whether a card payment through a payment processor requires a fiscal
  receipt under Ordinance N-18.** Not read. Settled by the ordinance and by the NRA.
- **NOT ESTABLISHED — the accounting-law requirements for a document where Art. 113(3) allows no
  invoice.** The Accountancy Act was not read.
- **NOT ESTABLISHED — the amounts of the sanctions in euro.** The consolidated text still states
  them in leva.
- **NOT ESTABLISHED — the EU small-enterprise scheme as an alternative to OSS.** Only its
  existence, its EUR 100,000 Union ceiling and its 35-working-day check were read.
- **NOT ESTABLISHED — corporate income tax and any other direct tax.** Out of scope.

**EU**

- **NOT ESTABLISHED — that the product is an electronically supplied service.** The
  classification is an inference from Implementing Regulation Art. 7 and Annex II of the
  Directive. Settled by an NRA written opinion.
- **NOT ESTABLISHED — the texts of the Directive and of the Implementing Regulation as amended
  after the versions read.** The Directive was read as consolidated on 2025-04-14 and the
  Implementing Regulation as consolidated on 2022-07-01. Later amendments, if any, were not
  checked.
- **NOT ESTABLISHED — per-member-state consumer requirements**: language of the terms, the
  dispute body to name, and any national addition to the CRD. Each member state is its own
  question.
- **NOT ESTABLISHED — which country's consumer law governs a contract with a consumer in another
  member state.** The Rome I Regulation was not read.

**United States**

- **NOT ESTABLISHED — every state threshold in section 2.3.** They are Stripe's statements, not
  the states'. The table is what Stripe published on the date read; whether each state's rule has since
  changed was not checked. Settled state by state at the state's revenue
  department, starting with the first state that has customers.
- **NOT ESTABLISHED — whether the product is taxable in each state.** Not examined at all.
- **NOT ESTABLISHED — the absence of a federal sales tax and the constitutional basis for
  economic nexus.** Stated in section 2.3 from Stripe's description; the Supreme Court decision
  was not read.
- **NOT ESTABLISHED — US consumer-protection rules for subscriptions**: automatic-renewal and
  cancellation rules, federal and state.
- **NOT ESTABLISHED — how long a state registration takes.**

**Canada**

- **NOT ESTABLISHED — the Saskatchewan, Manitoba, British Columbia and Quebec thresholds.**
  Stripe's statements. Settled at each province's revenue authority.
- **NOT ESTABLISHED — how long the simplified GST/HST registration takes.** The pages read do
  not say.
- **NOT ESTABLISHED — Canadian and provincial consumer-protection rules for subscriptions.**

**Elsewhere**

- **NOT ESTABLISHED — Mexico, and every country outside the EU, the United States and Canada.**
- **NOT ESTABLISHED — how long Stripe takes to activate a live account for this company**, and
  whether a Stripe invoice can be configured to carry every Art. 114(1) field other than the
  number.

---

## 8. Sources

All read on 2026-11-17.

| Source | Version read | URL |
|---|---|---|
| Bulgarian VAT Act (ЗДДС): Art. 3, 20b, 21, 66, 70, 82, 86, 87, 94, 96, 97a, 100, 101, 102, 103, 108, 111a, 113, 114, 117, 121, 125, 152, 156, 159, 168c, 168e, 168g, 178 | Consolidated text on lex.bg, last amendment listed State Gazette No. 115 of 30 December 2025 | https://lex.bg/laws/ldoc/2135533201 |
| NRA, "Регистрация по ЗДДС" | Page as served; no page date | https://nra.bg/wps/wcm/connect/agency/site/taxes/dds-v-balgariya/registratsiya-po-zdds |
| NRA, special schemes (OSS) | Page as served; no page date | https://nra.bg/wps/portal/nra/taxes/dds-pr-sdelki-v-ES/Specialen-rejim-v-Suuza-i-specialen-rejim-izvun-Suuza/specialen-rejim-v-suuza-i-specialen-rejim-izvun-suuza |
| Council Directive 2006/112/EC: Art. 44, 58, 59c, 196, 214, 284, 369a to 369f, Annex II | Consolidated 14.04.2025, from the EU Publications Office | https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02006L0112-20250414 |
| Council Implementing Regulation (EU) No 282/2011: Art. 7, 18, 24b, 24f, 57d | Consolidated 01.07.2022, from the EU Publications Office | https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02011R0282-20220701 |
| Directive 2011/83/EU: Art. 2, 7, 8, 9, 14, 16 | Consolidated 28.05.2022, from the EU Publications Office | https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02011L0083-20220528 |
| Directive (EU) 2023/2673: Art. 1 (new Art. 11a) and Art. 2 | As published | https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023L2673 |
| Bulgarian Consumer Protection Act (ЗЗП): Art. 50, 52a, 57 | Consolidated text on lex.bg, last amendment listed State Gazette No. 87 of 24 September 2026 | https://lex.bg/laws/ldoc/2135513678 |
| Canada Revenue Agency, cross-border digital products and services threshold amounts | Page dated 2025-10-16 | https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/digital-economy-gsthst/find-out-need-register/cross-border-threshold-amounts.html |
| Canada Revenue Agency, get ready to register | Page dated 2025-10-16 | https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/digital-economy-gsthst/register-get-ready.html |
| Stripe, set up Stripe Tax | As served | https://docs.stripe.com/tax/set-up |
| Stripe, register for tax | As served | https://docs.stripe.com/tax/registering |
| Stripe, monitoring | As served | https://docs.stripe.com/tax/monitoring |
| Stripe, tax filing | As served | https://docs.stripe.com/tax/filing |
| Stripe, zero tax and reverse charge | As served | https://docs.stripe.com/tax/zero-tax |
| Stripe, tax in the European Union | As served | https://docs.stripe.com/tax/supported-countries/european-union |
| Stripe, collect tax in the United States, one page per state | As served | https://docs.stripe.com/tax/supported-countries/united-states/collect-tax |
| Stripe, collect tax in Canada, federal and four provinces | As served | https://docs.stripe.com/tax/supported-countries/canada/collect-tax |
| Stripe, customer tax IDs | As served | https://docs.stripe.com/billing/customer/tax-ids |
| Stripe, customize invoices (numbering) | As served | https://docs.stripe.com/invoicing/customize |

How the texts were read: the two lex.bg acts, the four EU acts and the Stripe pages were
downloaded whole and the articles extracted from the text, so the quotations are copied, not
recalled. The NRA and Canada Revenue Agency pages were read through a fetch tool that returns
short excerpts; the quotations from them are those excerpts.

## 9. 2026-11-24: card sales move to a merchant of record

Recorded on 2026-11-24. This section changes nothing above it; it records a decision that
narrows where the rest of this document applies.

**The decision.** Self-serve card sales (subscriptions, usage and AI credit packs) are made by
Paddle (Paddle.com Market Ltd, UK; Paddle.com Inc. for buyers in the United States) as reseller
and merchant of record. Paddle is the seller to the customer: it charges the customer, calculates
and remits the VAT or sales tax in the customer's jurisdiction, and issues the customer's invoice.
Alethia Labs makes one supply a month, to Paddle.com Market Ltd. The cells for these sales are in
`MOR_MARKETS` (`packages/legal/src/mor-markets.ts`), empty until go-live; the conditions are in
`PAID_MARKETS.md` § "Merchant-of-record cells". The company applied for full VAT registration on
the same day, with effect expected around 2026-12-01; the Terms' statement that the company is not
registered for VAT changes in a separate, dated edit after the registration act.

**What no longer applies to card sales through Paddle** [I]:

- per-customer VAT: the EU OSS scheme (§2.2), the EUR 10,000 threshold, the reverse charge and
  the VAT-number dimension (§3.3, §3.4) — the customer's tax is Paddle's;
- US and Canadian sales-tax nexus and registration (§2.3, §3.6, §3.7);
- invoicing each customer (§2.4) and Наредба Н-18 receipts for those sales — Paddle issues the
  customer's invoice.

What replaces them is one question for the accountant: the monthly supply to Paddle.com Market
Ltd under ЗДДС чл. 21(2) (place of supply in the UK, outside Bulgarian VAT), whether Н-18 reaches
any part of it, and whether the document is our фактура or Paddle's self-billing. **Not
established** until the accountant answers in writing.

**What still applies.** Enterprise and services contracts are concluded directly with Alethia
Labs and paid by bank transfer against our фактура. They keep every per-cell rule in §3 and stay
gated by `PAID_MARKETS`. The consumer-law duties in §2.5 still apply to consumer sales through
Paddle; the division of them between Paddle and us is for the lawyer review.
