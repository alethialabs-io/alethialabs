// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import {
	connectorAuthMethod,
	connectorCategory,
	connectorStatus,
} from "./enums";

// Public catalog of available connectors (registry of record).
export const connectors = pgTable("connectors", {
	id: uuid().primaryKey().defaultRandom(),
	slug: text().notNull().unique(),
	name: text().notNull(),
	description: text().notNull(),
	category: connectorCategory().notNull(),
	auth_method: connectorAuthMethod().notNull(),
	organization: text().notNull(),
	icon_url: text().notNull(),
	docs_url: text(),
	support_url: text(),
	privacy_url: text(),
	status: connectorStatus().default("active").notNull(),
	sort_order: integer().default(0).notNull(),
	created_at: timestamp({ withTimezone: true }).defaultNow(),
	updated_at: timestamp({ withTimezone: true }).defaultNow(),
});

export type Connector = typeof connectors.$inferSelect;
