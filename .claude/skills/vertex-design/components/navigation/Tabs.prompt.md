One-line: Switch between views — Plan / Review tabs, provider tabs, dashboard sections.

```jsx
const [tab, setTab] = React.useState("plan");
<Tabs tabs={["plan", "review", "logs"]} value={tab} onValueChange={setTab} />
<Tabs variant="pill" tabs={[{id:"aws",label:"AWS"},{id:"gcp",label:"GCP"}]} value={p} onValueChange={setP} />
```

Controlled: own the `value` in state. `variant="underline"` (default) or `"pill"`.
