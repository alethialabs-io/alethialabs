One-line: Toggle a setting on or off (Karpenter autoscaling, ArgoCD self-healing, zone-redundant HA).

```jsx
<Switch defaultChecked />
<Switch checked={ha} onChange={(e) => setHa(e.target.checked)} />
```
