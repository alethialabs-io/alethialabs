// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/legal/legal-shell";

const REPOSITORY = "https://github.com/alethialabs-io/alethialabs";

export const metadata: Metadata = {
  title: "Source and licences · Alethia",
  description:
    "Licence boundaries and source-version information for Alethia's AGPL community core.",
};

export default function SourcePage() {
  const commit =
    process.env.ALETHIA_SOURCE_COMMIT ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.NEXT_PUBLIC_APP_VERSION ??
    "development";
  const sourceUrl =
    process.env.ALETHIA_CORE_SOURCE_URL ??
    (commit !== "development" ? `${REPOSITORY}/tree/${commit}` : REPOSITORY);

  return (
    <LegalShell title="Source and licences" lastUpdated="July 29, 2026">
      <p>
        Alethia uses an open-core model. The community core is licensed under
        the GNU Affero General Public License, version 3 only. Files under{" "}
        <code>ee/</code> use separate commercial terms and are not granted under
        the AGPL.
      </p>

      <h2>Deployed community source</h2>
      <p>
        This deployment identifies its core source version as{" "}
        <strong>
          <code>{commit}</code>
        </strong>
        .
      </p>
      <p>
        <a href={sourceUrl}>
          View or download the corresponding community source
        </a>
        . The archive or repository tree includes the source and build material
        for the community components. It does not grant rights to commercially
        licensed enterprise files.
      </p>

      <h2>Licence documents</h2>
      <ul>
        <li>
          <a href={`${REPOSITORY}/blob/main/LICENSE`}>
            GNU AGPLv3 licence text
          </a>
        </li>
        <li>
          <a href={`${REPOSITORY}/blob/main/LICENSING.md`}>
            Repository licence map
          </a>
        </li>
        <li>
          <a href={`${REPOSITORY}/blob/main/NOTICE`}>
            Copyright and third-party notices
          </a>
        </li>
      </ul>

      <h2>Questions</h2>
      <p>
        For licensing questions, contact{" "}
        <Link href="mailto:legal@alethialabs.io">legal@alethialabs.io</Link>.
      </p>
    </LegalShell>
  );
}
