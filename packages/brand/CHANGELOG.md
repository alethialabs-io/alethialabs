# @repo/brand

## 0.3.0

### Minor Changes

- 2518979: Add `./thinking-indicator` (#7870): `ThinkingIndicator`, the inline `[·]` mark beside a rotating progressive verb for an agent that is thinking. It starts on a random verb from `THINKING_VERBS` (283 of them), changes every 2.5s and never repeats any of the last 20; under reduced motion the verb is fixed and the mark static. Screen readers hear "Thinking" once through `role="status"`, not every rotation. Also exports `THINKING_VERBS`, `BANNED_VERB_STEMS`, `startVerbRotation`, `pickNextVerb` and `useReducedMotion`.

### Patch Changes

- Updated dependencies [9ff6629]
- Updated dependencies [d1ba621]
  - @repo/ui@0.4.0

## 0.2.2

### Patch Changes

- 08d1b28: `ProviderId` (the `Prov` logo's id) now accepts every provider `ProviderIcon` draws, including Hetzner, instead of only AWS, GCP and Azure.

## 0.2.1

### Patch Changes

- Updated dependencies [c714998]
  - @repo/ui@0.3.0

## 0.2.0

### Minor Changes

- 1d4cd23: Add the once-per-session intro splash: `IntroSplash` from `@repo/brand/site-intro-splash` (`[ Alethia · LABS ]` over "Truth, brought into focus.", CSS-only motion in `tokens.css` under `.ah-intro*` with a reduced-motion rule), and its inline `<head>` gate `INTRO_GATE_SCRIPT` from `@repo/brand/site-intro-gate`.
- ee3d8cb: Add the `[·]` mark loader: `MarkLoader` from `@repo/brand/loader` (inline, region and page sizes, CSS-only motion in `tokens.css` with a reduced-motion rule), a `pending` prop on `Button`, and `Spinner` now draws the mark.

### Patch Changes

- Updated dependencies [0c2b83c]
- Updated dependencies [c903fb6]
- Updated dependencies [ee3d8cb]
- Updated dependencies [379329f]
  - @repo/legal@0.1.2
  - @repo/ui@0.2.0

## 0.1.1

### Patch Changes

- 08f55f5: Describe each package on npm instead of the placeholder "Alethia <name>".
- Updated dependencies [08f55f5]
  - @repo/legal@0.1.1
  - @repo/privacy@0.1.1
  - @repo/ui@0.1.1

## 0.1.0

### Minor Changes

- eaeb9a3: First public release on npm as `@alethialabs/*`.

### Patch Changes

- Updated dependencies [eaeb9a3]
  - @repo/legal@0.1.0
  - @repo/privacy@0.1.0
  - @repo/ui@0.1.0
