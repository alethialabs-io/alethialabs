---
"@repo/brand": minor
---

Add `./thinking-indicator` (#7870): `ThinkingIndicator`, the inline `[·]` mark beside a rotating progressive verb for an agent that is thinking. It starts on a random verb from `THINKING_VERBS` (283 of them), changes every 2.5s and never repeats any of the last 20; under reduced motion the verb is fixed and the mark static. Screen readers hear "Thinking" once through `role="status"`, not every rotation. Also exports `THINKING_VERBS`, `BANNED_VERB_STEMS`, `startVerbRotation`, `pickNextVerb` and `useReducedMotion`.
