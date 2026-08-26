// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';

const eslintConfig = defineConfig([
  ...nextVitals,
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    '.source/**',
  ]),
  {
    // An app may not reach into a SIBLING app with a relative path. On 2026-07-30 #1711 put a
    // marketing test under apps/console importing '../../../marketing/proxy'; console's tsconfig
    // includes **/*.ts, so that dragged apps/marketing/proxy.ts into the CONSOLE type-check, and
    // the console image installs --filter console... (no marketing) — so next/server did not
    // resolve there and TS2307 broke every production deploy for 26 days. Full CI stayed green
    // because it installs the whole workspace. Shared code is PROMOTED to packages/*, never
    // reached across for. This catches it at lint time instead of in a buildx log.
    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          basePath: import.meta.dirname,
          zones: [{ target: '.', from: '../', except: ['./docs'] }],
        },
      ],
    },
  },
]);

export default eslintConfig;