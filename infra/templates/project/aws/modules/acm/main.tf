# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only

resource "aws_acm_certificate" "cf_alias" {
  domain_name               = var.domain_name
  subject_alternative_names = var.subject_alternative_names
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# ONE Route 53 record per validation option, not per certificate.
#
# ACM emits a separate entry in domain_validation_options for the primary domain AND for every
# subject alternative name. This resource used to be a single record built from
# tolist(...)[0], so the moment the certificate carried a SAN there was a validation option
# that no DNS record satisfied: aws_acm_certificate_validation then blocked until its timeout
# and the apply died with no error naming the SAN. (The GCP shape of the same trap is worse
# still — one unresolvable SAN puts the whole managed certificate in FAILED_NOT_VISIBLE.)
#
# Keyed by domain_name, the pattern the AWS provider documents. A wildcard and its apex share
# one validation token, so `*.example.com` + `example.com` yield two options with an IDENTICAL
# resource_record_name and value; both are UPSERTs of the same record, which is why
# allow_overwrite stays true. It is a no-op collision, not a conflict.
resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.cf_alias.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  type            = each.value.type
  zone_id         = var.r53_zone_id
  ttl             = 60
}

# Every record, so validation only returns once EVERY name on the certificate is proven. Passing
# a subset is what made the failure a timeout rather than an error.
resource "aws_acm_certificate_validation" "cert" {
  certificate_arn         = aws_acm_certificate.cf_alias.arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}
