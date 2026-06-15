One-line: Communicates job/cluster/worker state without color — fill and shape of the dot carry the meaning.

```jsx
<StatusBadge status="active" />     {/* solid dot */}
<StatusBadge status="processing" />{/* haloed dot */}
<StatusBadge status="failed" />     {/* hollow-center dot */}
<StatusBadge status="live">Streaming</StatusBadge> {/* blinking */}
<StatusBadge status="online" showLabel={false} />
```

Tiers: `active`/`online`/`success` (solid), `pending`/`processing`/`queued` (haloed), `idle` (ring), `failed`/`destroyed` (hollow center), `disabled` (faint), `live` (blinking). This is the system's deliberate stand-in for status color.
