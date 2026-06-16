One-line: Toggles for boolean and single-choice options in config forms.

```jsx
<Checkbox defaultChecked>Single NAT Gateway</Checkbox>
<Radio name="ha" defaultChecked>Multi-AZ</Radio>
<Radio name="ha">Single zone</Radio>
```

Pass label text as children. Standard `checked`/`defaultChecked`/`onChange`/`disabled` apply.
