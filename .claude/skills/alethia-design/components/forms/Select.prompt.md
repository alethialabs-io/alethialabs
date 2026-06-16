One-line: Dropdown for choosing a region, instance type, k8s version, or provider.

```jsx
<Select options={["eu-west-1", "us-east-1", "ap-southeast-2"]} defaultValue="eu-west-1" />
<Select>
  <option>m5.large</option>
  <option>m5.xlarge</option>
</Select>
```

Pass `options` (strings or `{value,label}`) or `<option>` children.
