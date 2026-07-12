resource "vault_generic_secret" "s" {
  path = "secret/creds"

  data_json = "{}"
}
