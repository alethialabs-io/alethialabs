# Vendored brand fonts

These files are third-party font software, licensed under the **SIL Open Font License 1.1**. They
are not Alethia's work, and the repository's AGPL-3.0 licence does not apply to them. Each family's
licence text, with its copyright notice, is in the `OFL-*.txt` file next to it.

The apps load these files through `@repo/brand/fonts` (`../fonts.ts`) with `next/font/local`, so no
build downloads a font from the network (#4986).

| File | Family | Licence text | Upstream copyright |
|---|---|---|---|
| `geist-latin-wght-normal.woff2` | Geist, variable weight 100–900 | `OFL-Geist.txt` | The Geist Project Authors (github.com/vercel/geist-font) |
| `geist-mono-latin-wght-normal.woff2` | Geist Mono, variable weight 100–900 | `OFL-GeistMono.txt` | The Geist Project Authors (github.com/vercel/geist-font) |
| `space-grotesk-latin-wght-normal.woff2` | Space Grotesk, variable weight 300–700 | `OFL-SpaceGrotesk.txt` | The Space Grotesk Project Authors (github.com/floriankarsten/space-grotesk) |

## Provenance

The files are byte-for-byte copies from the npm packages below. We did not rename, subset, or edit
them. Fontsource builds these packages from the Google Fonts distribution (github.com/google/fonts),
so each file is the Google Fonts `latin` subset: the same subset the apps downloaded at build time before.
The glyph version can still differ from what Google served on a given day. Nothing pins Google's
CDN, and Fontsource republishes when Google updates a family.

| Package | Version | npm integrity | Upstream `lastModified` |
|---|---|---|---|
| `@fontsource-variable/geist` | 5.3.0 | `sha512-j0m+vLQuG5XAYoHtGCVu0spvlGreR3EzpECUVzkFmI1mTVnAO38l/NEPDCFgZ177JxzYJCLSmTQibIiYPilGrA==` | 2026-05-13 |
| `@fontsource-variable/geist-mono` | 5.3.0 | `sha512-vBbuwDEo9AkrqADMXOrlAR3DFcJi4/JxeuU43FoiQERnNwsfXNnvxvReZG02cQKmyk4DZkZdBZX3oTDvy2zBAw==` | 2026-06-08 |
| `@fontsource-variable/space-grotesk` | 5.3.0 | `sha512-2IxmvfB08i9vnGB3Ym/AXvhRE+8XOjWMXIyDum03c+tPwH0FUoMNQfGpU8NXPxjbws0Vvss3AH0Zqt4oJBBAdw==` | 2025-09-05 |

SHA-256 of each committed file:

```
19f9c92546aa300c312235e3125af1b81394d8db9a4bc4a425cd5b641d2d54e1  geist-latin-wght-normal.woff2
684ad5b531f81d43c1e8c7038262d5db7cdc1f68006e04d6c7769efa8d33c8cc  geist-mono-latin-wght-normal.woff2
0640890476fc1198ab4de571fb658de443c4d85b66466ec09534a8737ab1ce9d  space-grotesk-latin-wght-normal.woff2
```

## Updating

1. `npm pack @fontsource-variable/<family>@<version>`.
2. Copy `files/<family>-latin-wght-normal.woff2` and `LICENSE` (as `OFL-<Family>.txt`) over the files
   here.
3. Update both tables above.

The OFL lets us bundle and redistribute the fonts with software. It does not let us sell them on
their own. None of the three licence files declares a Reserved Font Name.
