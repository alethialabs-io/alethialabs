// SPDX-FileCopyrightText: 2026 Borislav Borisov and contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The deliberately small, edition-neutral protocol between Alethia Community
 * and an optional extension package. Concrete capabilities stay in their owning
 * package; this module only describes registration and edition selection.
 */
export type AlethiaEdition = "community" | "enterprise" | "auto";

export type EnterpriseEntrypoint<TCore, TModule> = (core: TCore) => TModule;

export interface EnterprisePackage<TCore, TModule> {
  register: EnterpriseEntrypoint<TCore, TModule>;
}

export function parseAlethiaEdition(value?: string): AlethiaEdition {
  if (value === undefined || value === "") return "auto";
  if (value === "community" || value === "enterprise" || value === "auto") {
    return value;
  }
  throw new Error(
    `Invalid ALETHIA_EDITION=${value}; expected community, enterprise, or auto.`,
  );
}
