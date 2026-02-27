Environment on first page to not be drop down but free text field, as there might be many use cases
Add more terraform versions, at least stable latest versions until 1.11.4
Add more AWS regions
Database to also be a "feature toggle" e.g. to be able to disable it


Use new format for users:



eks_cluster_admins:
  - username: "mihail.vukadinoff@itgix.com"
    path: /
  - username: "hristiyan.tonev@itgix.com"
    path: /

Db should be able to provide decimal for ACUs - e.g 0.5, 1.5 are valid

When you press "back to configuration" - it throes a 404 error
We need also destination repo for argo infra tools

now we can only do app repo destination it seems
When downloading config , we get
No configuration data available. Please complete the configuration form first.
