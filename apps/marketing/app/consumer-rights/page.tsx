// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	CONSUMER_ADR,
	CONSUMER_PAYMENT_OBLIGATION_LABEL,
	CONSUMER_PAYMENT_OBLIGATION_LABEL_BG,
	PAID_MARKETS,
	WITHDRAWAL_PERIOD_DAYS,
} from "@repo/legal/commerce";
import { CURRENT_LEGAL_OPERATOR, LEGAL_ENTITY } from "@repo/legal/entity";
import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/legal/legal-shell";

export const metadata: Metadata = {
	title: "Consumer rights",
	description:
		"Your statutory rights when buying Alethia as a consumer: the 14-day withdrawal right, what it costs, and where to take a dispute.",
};

/**
 * Consumer rights for a distance contract, in the words a consumer can act on.
 *
 * DERIVED, not restated. The withdrawal period, the payment-obligation wording, the dispute bodies
 * and whether we can sell to consumers at all all come from `@repo/legal/commerce` — the same module
 * the server-side gate and the withdrawal accounting read. A page that retyped them would be the
 * copy that drifts, and it would drift in the direction of whatever was easiest to write.
 *
 * TWO LANGUAGES, ONE SEAL. The Bulgarian section (`#bg`) says what the English says, for buyers in
 * Bulgaria (ЗЗП art. 52a and the Bulgarian-language rule for consumer information). Both halves are
 * in this one file, so the hash in `LEGAL_DOCUMENTS` covers both, and the withdrawal acknowledgement
 * email quotes sentences from each verbatim (tests/lib/email/withdrawal-acknowledgement.test.ts in
 * the console).
 */
export default function ConsumerRightsPage() {
	const sellsToConsumers = PAID_MARKETS.some((c) => c.capacity === "consumer");

	return (
		<LegalShell title="Consumer rights" lastUpdated="November 24, 2026">
			<p>
				This page is for people buying Alethia as an individual, outside a trade,
				business or profession. If you are buying on behalf of a company, these
				statutory rights do not apply to you — your{" "}
				<Link href="/terms">Terms of Service</Link> govern instead. We ask which
				you are at the point of purchase and never guess, because the answer
				changes which law applies.
			</p>

			{!sellsToConsumers && (
				<>
					<h2>We are not currently selling to consumers</h2>
					<p>
						{CURRENT_LEGAL_OPERATOR} has not yet opened paid plans to individuals
						in any country, so we do not currently take payment from
						individuals. Community
						remains free and
						unlimited in time, and the Pro trial requires no card. This page
						describes the rights that will apply when consumer sales open, and
						it is published now so those rights are on the record before any
						money changes hands rather than after.
					</p>
				</>
			)}

			<h2>Before you order</h2>
			<p>
				We show the total price you will pay, including any tax, before you
				order — not a price that grows at the last step. We tell you whether the
				subscription renews, when, and how to stop it. The button that places the
				order says “{CONSUMER_PAYMENT_OBLIGATION_LABEL}”, because an order that
				costs money should say so on the button and not in a paragraph above it.
			</p>
			<p>
				After you order we send you a confirmation you can keep, containing what
				you bought, what you paid, and these rights.
			</p>

			<h2>Your {WITHDRAWAL_PERIOD_DAYS}-day right to withdraw</h2>
			<p>
				You may withdraw from the contract within {WITHDRAWAL_PERIOD_DAYS} days
				of placing your order, for any reason, and you do not have to tell us
				why. You can do it by emailing{" "}
				<a href={`mailto:${LEGAL_ENTITY.contactEmail}`}>
					{LEGAL_ENTITY.contactEmail}
				</a>
				. We tell you what you will get back <em>before</em> the withdrawal
				takes effect. You can also withdraw from the billing settings in the
				console, which shows what you will get back before you confirm.
			</p>
			<p>
				A card purchase is sold to you by our reseller, Paddle, so you can also
				withdraw directly with Paddle, at{" "}
				<a href="https://www.paddle.net" rel="noopener noreferrer" target="_blank">
					paddle.net
				</a>{" "}
				or through Paddle’s buyer support. If you write to us instead, we pass
				your withdrawal on to Paddle for you — you never have to do it twice.
			</p>

			<h3>What withdrawing costs you</h3>
			<p>
				That depends on one choice you make when you order — whether the service
				should start straight away, or wait until the {WITHDRAWAL_PERIOD_DAYS}{" "}
				days are up.
			</p>
			<ul>
				<li>
					<strong>If you asked us to wait</strong>, nothing was supplied, and you
					get the whole amount back.
				</li>
				<li>
					<strong>If you asked us to start straight away</strong> and confirmed
					you understood the consequence, you pay for the part you actually used
					— worked out day by day against the period you paid for — and we refund
					the rest. Any fraction of a cent goes to you, not to us.
				</li>
				<li>
					<strong>If you asked us to start straight away but were never asked to
					confirm that consequence</strong>, you owe nothing at all, even though
					the service ran. That is the law’s sanction on us for not asking
					properly, and we apply it to ourselves rather than making you argue
					for it.
				</li>
			</ul>
			<p>
				Withdrawing ends your access immediately, and we refund you using the
				same payment method you paid with, without a fee. If we cannot refund
				automatically, for example because there was no card payment to refund
				against, we contact you within 14 days to arrange it.
				For a card purchase, the refund is issued by Paddle, the seller of that
				purchase.
			</p>

			<h2>Cancelling is a different thing</h2>
			<p>
				After the {WITHDRAWAL_PERIOD_DAYS} days, you can still cancel at any
				time. Cancelling stops the next renewal and your access continues to the
				end of the period you have already paid for — you keep what you paid
				for.
			</p>
			<p>
				In addition to these statutory rights, our{" "}
				<Link href="/refunds">Refund Policy</Link> gives everyone the same
				voluntary money-back: a first subscription payment or an annual renewal
				is refunded in full if you ask within 14 days, and an unused credit pack
				within 14 days of buying it. A monthly renewal is not refunded, and usage
				charges are refunded only for a billing error, which we always correct.
				Where both the statutory right and the policy apply, you get whichever
				gives you more. The policy applies in the same way to everyone, because
				a refund that depends on who asks is not a right.
			</p>

			<h2>If something goes wrong</h2>
			<p>
				Write to us first at{" "}
				<a href={`mailto:${LEGAL_ENTITY.supportEmail}`}>
					{LEGAL_ENTITY.supportEmail}
				</a>{" "}
				— most things are faster to fix than to escalate. If that does not
				resolve it, you can take the matter to:
			</p>
			<ul>
				{CONSUMER_ADR.map((body) => (
					<li key={body.url}>
						<a href={body.url} rel="noopener noreferrer" target="_blank">
							{body.name}
						</a>{" "}
						({body.localName}) — {body.role}
					</li>
				))}
			</ul>
			<p>
				We are not obliged to use, and do not commit to, any particular
				alternative dispute resolution body; the ones above are named so you know
				where to go. The European Commission’s online dispute resolution platform
				is not listed because it was shut down in July 2025 — you may still see it
				cited on other traders’ sites.
			</p>

			<h2>Who sells to you, and who provides the service</h2>
			<p>
				A card purchase — a subscription, usage charges or a credit pack — is
				sold to you by Paddle.com Market Ltd (Paddle.com Inc. if you are in the
				United States), our reseller and merchant of record. Paddle takes your
				payment, adds and pays the tax, issues your invoice and processes
				refunds, under{" "}
				<a
					href="https://www.paddle.com/legal/checkout-buyer-terms"
					rel="noopener noreferrer"
					target="_blank"
				>
					Paddle’s Buyer Terms
				</a>
				. The service itself is provided to you by:
			</p>
			<p>
				{LEGAL_ENTITY.legalName}, {LEGAL_ENTITY.legalForm.toLowerCase()},
				registered in {LEGAL_ENTITY.jurisdiction} under EIK{" "}
				{LEGAL_ENTITY.registrationNumber}, at {LEGAL_ENTITY.registeredAddress}.
				Full details are on the <Link href="/imprint">company information</Link>{" "}
				page.
			</p>

			<section id="bg" lang="bg">
				<h2>Права на потребителите (на български език)</h2>
				<p>
					Тази част е за лица, които купуват Alethia като физически лица извън
					своята търговска или професионална дейност. Ако купувате от името на
					дружество, тези законови права не се прилагат за Вас — вместо тях се
					прилагат <Link href="/terms">Общите условия</Link>. При поръчката
					питаме в какво качество купувате и никога не предполагаме, защото
					отговорът определя кой закон се прилага.
				</p>

				{!sellsToConsumers && (
					<>
						<h3>Все още не продаваме на потребители</h3>
						<p>
							{CURRENT_LEGAL_OPERATOR} все още не предлага платени планове на
							физически лица в нито една държава, затова в момента не приемаме
							плащания от физически лица. Community остава безплатен и без
							ограничение във времето, а пробният период на Pro не изисква карта.
							Тази страница описва правата, които ще се прилагат, когато започнат
							продажбите на потребители, и е публикувана сега, за да бъдат тези
							права оповестени, преди да бъдат платени каквито и да е суми, а не
							след това.
						</p>
					</>
				)}

				<h3>Преди да поръчате</h3>
				<p>
					Преди да поръчате, Ви показваме общата цена, която ще платите,
					включително всички данъци — а не цена, която нараства на последната
					стъпка. Казваме Ви дали абонаментът се подновява, кога и как да го
					спрете. Бутонът, с който се прави поръчката, гласи „
					{CONSUMER_PAYMENT_OBLIGATION_LABEL_BG}“, защото поръчка, която струва
					пари, трябва да казва това на бутона, а не в абзац над него.
				</p>
				<p>
					След поръчката Ви изпращаме потвърждение, което можете да запазите и
					което съдържа какво сте купили, колко сте платили и тези права.
				</p>

				<h3>Право на отказ в срок от {WITHDRAWAL_PERIOD_DAYS} дни</h3>
				<p>
					Можете да се откажете от договора в срок от {WITHDRAWAL_PERIOD_DAYS}{" "}
					дни от направата на поръчката, по каквато и да е причина, без да е
					необходимо да ни я посочвате. Можете да го направите, като ни пишете
					на{" "}
					<a href={`mailto:${LEGAL_ENTITY.contactEmail}`}>
						{LEGAL_ENTITY.contactEmail}
					</a>
					. Казваме Ви какво ще получите обратно, <em>преди</em> отказът да
					породи действие. Можете да се откажете и от настройките за плащане в
					конзолата, които показват какво ще получите обратно, преди да
					потвърдите.
				</p>
				<p>
					Покупката с карта Ви се продава от нашия препродавач Paddle, затова
					можете да се откажете и директно чрез Paddle — на{" "}
					<a href="https://www.paddle.net" rel="noopener noreferrer" target="_blank">
						paddle.net
					</a>{" "}
					или чрез службата за поддръжка на купувачи на Paddle. Ако вместо това
					ни пишете на нас, ние предаваме отказа Ви на Paddle — никога не се
					налага да го правите два пъти.
				</p>

				<h4>Какво Ви струва отказът</h4>
				<p>
					Това зависи от един избор, който правите при поръчката — дали услугата
					да започне веднага, или да изчака изтичането на{" "}
					{WITHDRAWAL_PERIOD_DAYS}-те дни.
				</p>
				<ul>
					<li>
						<strong>Ако сте поискали да изчакаме</strong>, нищо не е
						предоставено и получавате обратно цялата сума.
					</li>
					<li>
						<strong>Ако сте поискали да започнем веднага</strong> и сте
						потвърдили, че разбирате последицата, заплащате частта, която
						действително сте използвали — изчислена ден по ден спрямо платения
						период — а останалото Ви възстановяваме. Всяка част от цент остава
						за Вас, а не за нас.
					</li>
					<li>
						<strong>Ако сте поискали да започнем веднага, но никога не сте
						били помолени да потвърдите тази последица</strong>, не дължите
						нищо, въпреки че услугата е била предоставяна. Това е санкцията,
						която законът налага на нас, задето не сме попитали както трябва, и
						ние я прилагаме сами, вместо да Ви караме да я отстоявате.
					</li>
				</ul>
				<p>
					Отказът прекратява достъпа Ви незабавно и Ви възстановяваме сумата
					чрез същото платежно средство, с което сте платили, без такса. Ако не
					можем да възстановим сумата автоматично, например защото няма плащане
					с карта, срещу което да я възстановим, се свързваме с Вас в срок от 14
					дни, за да уредим възстановяването.
					При покупка с карта сумата се възстановява от Paddle — продавача по
					тази покупка.
				</p>

				<h3>Прекратяването е нещо различно</h3>
				<p>
					След изтичането на {WITHDRAWAL_PERIOD_DAYS}-те дни можете да
					прекратите абонамента по всяко време. Прекратяването спира следващото
					подновяване, а достъпът Ви продължава до края на вече платения период
					— запазвате това, за което сте платили.
				</p>
				<p>
					В допълнение към тези законови права нашата{" "}
					<Link href="/refunds">Политика за възстановяване на суми</Link> дава
					на всички еднаква доброволна възможност за връщане на парите: първото
					плащане по абонамент или годишното подновяване се възстановява
					изцяло, ако поискате в срок от 14 дни, а неизползван пакет кредити — в
					срок от 14 дни от покупката. Месечното подновяване не се възстановява,
					а таксите за използване се възстановяват само при грешка в
					таксуването, която винаги коригираме. Когато се прилагат и законовото
					право, и политиката, получавате по-благоприятното за Вас. Политиката
					се прилага еднакво за всички, защото възстановяване, което зависи от
					това кой пита, не е право.
				</p>

				<h3>Ако нещо се обърка</h3>
				<p>
					Първо ни пишете на{" "}
					<a href={`mailto:${LEGAL_ENTITY.supportEmail}`}>
						{LEGAL_ENTITY.supportEmail}
					</a>{" "}
					— повечето проблеми се решават по-бързо така, отколкото с жалба. Ако
					това не реши въпроса, можете да се обърнете към:
				</p>
				<ul>
					{CONSUMER_ADR.map((body) => (
						<li key={body.url}>
							<a href={body.url} rel="noopener noreferrer" target="_blank">
								{body.localName}
							</a>{" "}
							— {body.localRole}
						</li>
					))}
				</ul>
				<p>
					Не сме задължени да използваме и не поемаме ангажимент да използваме
					конкретен орган за алтернативно решаване на спорове; посочените по-горе
					са изброени, за да знаете къде да се обърнете. Платформата за онлайн
					решаване на спорове на Европейската комисия не е посочена, защото беше
					закрита през юли 2025 г. — възможно е все още да я виждате цитирана на
					сайтовете на други търговци.
				</p>

				<h3>Кой Ви продава и кой предоставя услугата</h3>
				<p>
					Покупката с карта — абонамент, такси за използване или пакет кредити —
					Ви се продава от Paddle.com Market Ltd (Paddle.com Inc., ако се
					намирате в Съединените щати), наш препродавач и търговец по
					продажбата (merchant of record). Paddle приема плащането Ви, начислява
					и внася данъка, издава Вашата фактура и извършва възстановяванията
					съгласно{" "}
					<a
						href="https://www.paddle.com/legal/checkout-buyer-terms"
						rel="noopener noreferrer"
						target="_blank"
					>
						Условията за купувачи на Paddle
					</a>
					. Самата услуга Ви се предоставя от:
				</p>
				<p>
					{LEGAL_ENTITY.legalNameBulgarian},{" "}
					{LEGAL_ENTITY.legalFormBulgarian.toLowerCase()}, регистрирано в{" "}
					{LEGAL_ENTITY.jurisdictionBulgarian} с ЕИК{" "}
					{LEGAL_ENTITY.registrationNumber}, със седалище и адрес на управление{" "}
					{LEGAL_ENTITY.registeredAddressBulgarian}. Пълните данни са на
					страницата с <Link href="/imprint">информация за дружеството</Link>.
				</p>
			</section>
		</LegalShell>
	);
}
