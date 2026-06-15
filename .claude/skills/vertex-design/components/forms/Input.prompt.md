One-line: Text entry for the visual configuration forms — pair with `Field`, `Label`, and `Hint`.

```jsx
<Field>
  <Label htmlFor="name">Project name</Label>
  <Input id="name" placeholder="api-backend" />
  <Hint>Lowercase, used as the Terraform workspace name.</Hint>
</Field>
<Input mono defaultValue="10.0.0.0/16" aria-label="CIDR block" />
<Textarea placeholder="Notes…" />
```

Set `mono` for CIDRs, tokens, and IDs. Set `aria-invalid="true"` to show the grayscale error treatment.
