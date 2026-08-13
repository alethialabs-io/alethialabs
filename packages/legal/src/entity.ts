// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/** Registered operator and controller for Alethia's hosted services. */
export const LEGAL_ENTITY = {
	tradingName: "Alethia Labs",
	legalName: "ALETHIA LABS",
	legalNameBulgarian: "АЛЕТИЯ ЛАБС",
	legalForm: "Single-member variable capital company",
	legalFormBulgarian: "Еднолично дружество с променлив капитал",
	registrationNumber: "208913663",
	registeredAt: "2026-08-11T17:48:00+03:00",
	status: "active",
	vatRegistered: false,
	vatNumber: null,
	jurisdiction: "Bulgaria",
	governingLaw: "Bulgaria",
	manager: "Borislav Ventsislavov Borisov",
	managerBulgarian: "Борислав Венциславов Борисов",
	registeredAddress:
		"9 Sirak Skitnik Street, entrance A, floor 4, apartment 7, Slatina District, 1111 Sofia, Bulgaria",
	registeredAddressBulgarian:
		"гр. София 1111, р-н Слатина, ул. Сирак Скитник № 9, вх. А, ет. 4, ап. 7, България",
	contactEmail: "legal@alethialabs.io",
	privacyEmail: "privacy@alethialabs.io",
	securityEmail: "security@alethialabs.io",
	supportEmail: "support@alethialabs.io",
	publicPhoneEnvironmentVariable: "ALETHIA_PUBLIC_PHONE",
	copyrightYears: "2026-present",
	dpa: {
		name: "Commission for Personal Data Protection",
		localName: "Комисия за защита на личните данни (КЗЛД)",
		url: "https://www.cpdp.bg/en/",
	},
};

/** Current service operator; named separately for readable public legal copy. */
export const CURRENT_LEGAL_OPERATOR = LEGAL_ENTITY.legalName;
