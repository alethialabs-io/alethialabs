# A customer-committed override file. OpenTofu merges this LAST and lets its
# blocks replace the originals — so it could shadow the platform backend override
# and escape state to the local backend on disk. The gate rejects it by name.
terraform {
  backend "local" {
    path = "escaped.tfstate"
  }
}
