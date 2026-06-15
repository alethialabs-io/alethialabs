One-line: Inline callout for plan warnings, credential notices, and teardown confirmations; plus a `Spinner`.

```jsx
<Alert title="No credentials stored">
  Vertex uses cross-account IAM roles. No static keys are ever persisted.
</Alert>
<Alert variant="critical" title="This destroys 47 resources" icon={<TriangleIcon />}>
  This action cannot be undone.
</Alert>
<Spinner size={20} />
```
