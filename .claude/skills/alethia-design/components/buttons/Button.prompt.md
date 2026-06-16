One-line: The button for every action in Alethia — solid `primary` for the one true CTA, `outline`/`secondary` for supporting actions, `ghost` for toolbar and nav.

```jsx
<Button variant="primary">Plant a Vine</Button>
<Button variant="outline" size="sm">View plan</Button>
<Button variant="ghost" icon aria-label="Settings"><GearIcon /></Button>
<Button variant="destructive">Destroy</Button>
```

Variants: `primary` (solid ink), `secondary` (muted fill), `outline` (hairline + faint shadow), `ghost` (transparent, fills on hover), `link`, `destructive` (grayscale outline that fills on hover — pair with a trash/alert icon). Sizes: `xs`, `sm`, `md` (default), `lg`. Add `icon` for square icon-only buttons. Use exactly one `primary` per view.
