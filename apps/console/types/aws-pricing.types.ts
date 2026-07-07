// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

export interface AwsPricingProduct {
	sku: string;
	attributes: Record<string, string>;
}

export interface AwsPricingTermDimension {
	pricePerUnit: { USD: string };
	unit: string;
	description: string;
}

export interface AwsPricingTerm {
	priceDimensions: Record<string, AwsPricingTermDimension>;
}

export interface AwsPricingResponse {
	products: Record<string, AwsPricingProduct>;
	terms: {
		OnDemand: Record<string, Record<string, AwsPricingTerm>>;
	};
}
