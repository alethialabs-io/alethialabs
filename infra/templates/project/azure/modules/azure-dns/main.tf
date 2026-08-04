resource "azurerm_dns_zone" "this" {
  name                = var.domain
  resource_group_name = var.resource_group_name

  tags = var.tags
}

# ── There is deliberately NO certificate resource here (#1825) ──────────────────────────
#
# This module used to create an `azurerm_app_service_certificate_order` behind
# `var.managed_certificate`. That resource is a PURCHASED App Service Certificate —
# GoDaddy-backed, ~$300/yr for a wildcard, with domain-verification steps — and it cannot be
# bound to an AKS ingress under any configuration. A user ticking "managed certificate" was
# billed for a certificate that terminated none of their traffic.
#
# It is deleted rather than replaced, and nothing takes its place in OpenTofu. Azure's
# `managed_certificate` switch is honored by **cert-manager**, which issues a Let's Encrypt
# certificate over an ACME DNS01 challenge using the same identity external-dns already holds
# (packages/core/argocd/cert_manager.go, gated per-cloud by `certManagerDNS01Solvers`). The
# Application Gateway serves it from the Kubernetes TLS Secret AGIC lifts off the Ingress.
#
# Why no other OpenTofu certificate took its place:
#   · a Front Door managed cert (`azurerm_cdn_frontdoor_custom_domain`) is free, but it inserts a
#     whole second ingress topology — origin group, route, validation TXT — in front of a cluster
#     whose traffic the Application Gateway already serves;
#   · `azurerm_key_vault_certificate` either imports one you already hold or issues from a
#     Key Vault-integrated CA account. Neither is free and neither is automatic, so it is a
#     bring-your-own-certificate knob, not an answer to a switch called "managed".
#
# GCP converges the same way (#1858). AWS does NOT, and that asymmetry is deliberate rather than
# unfinished: an ALB HTTPS listener can only reference a certificate by ARN in ACM or IAM, and
# ACM's own ACME endpoint refuses to bind its certificates to Elastic Load Balancing because it
# never holds the private key. So ACM stays there — two mechanisms, forced by the ELB API.
#
# The `managed_certificate` VARIABLE is deleted with it, and that part is not tidying.
#
# Keeping it — declared here, still passed by azure-dns.tf, read by nothing — manufactured a FALSE
# GREEN in the offer-parity guard. L5 asks whether the tfvar is declared in the template and read
# by a resource or module argument; `managed_certificate = var.azure_managed_certificate` in
# azure-dns.tf IS a module argument, so the cell scored as carried while the module discarded the
# value one level deeper than L5 looks. That is precisely the shape the carrier rule exists to
# catch — "a value that travels the whole way and is dropped one line before it means anything" —
# arriving through the guard's own blind spot.
#
# The user's ask does NOT travel this way, which is what makes the deletion safe: InfraFacts reads
# `vc.DNS.ManagedCertificate` from the config snapshot (infra_facts.go), never from a tofu output
# or tfvar. So the root variable and the provider's emit go too, and the cell honestly reports
# no OpenTofu carriage — recorded as `carried_in_cluster:` (cert-manager), which is the truth.
