// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/** The custom-role editor form: name, an optional description, and at least one permission. */
export const roleInputSchema = z.object({
	name: z.string().trim().min(1, "Name your role").max(120),
	description: z.string().max(500),
	permissionKeys: z.array(z.string()).min(1, "Grant at least one permission."),
});

export type RoleInput = z.infer<typeof roleInputSchema>;
