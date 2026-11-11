# Upgrading the runner

Notes an operator needs when moving to a newer runner. `CHANGELOG.md` is written by
release-please from commit messages, so hand-written notes live here instead. Keeping them out
of `CHANGELOG.md` stops them colliding with release-please's entries when `staging` is promoted
to `main`.

## AWS: IRSA roles name their exact ServiceAccounts (#6556)

Every IRSA role in the AWS project template now trusts only its exact ServiceAccounts, matched with
`StringEquals`. Three roles that nothing in the platform used are removed, with their policies:
`irsa-alethia-<cluster>`, `ai-bedrock-<cluster>` and `s3-bucket-<cluster>`.

**Re-deploy your AWS environments after upgrading.** The deploy re-applies the stack and deletes
these roles.

- **A ServiceAccount of your own annotated with one of these role ARNs** loses AWS access on the
  re-deploy. Create a role for that workload in your own IaC that trusts its exact
  `namespace:serviceaccount`, and annotate the ServiceAccount with it.
- **A policy you attached to one of these roles by hand** does not block the re-deploy. The roles
  are created with `force_detach_policies`, so deleting the role detaches your policy first. Your
  policy itself is kept.
- **One of the removed roles' own policies** (`irsa_alethia_agent*`, `irsa_ai_bedrock_custom*`,
  `irsa_ai_bedrock_s3*`) **that you attached by hand to another role, user or group** makes the
  re-deploy fail with `DeleteConflict`, because AWS does not delete a managed policy that is still
  attached. Detach it from your entity (`aws iam detach-role-policy`, `detach-user-policy` or
  `detach-group-policy`), then re-deploy.
