# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
# SPDX-License-Identifier: AGPL-3.0-only
#
# Proof that an ACM certificate validates EVERY name it carries, not just the first one (#1827).
#
# The defect: modules/acm built exactly ONE aws_route53_record from
# tolist(aws_acm_certificate.cf_alias.domain_validation_options)[0] and fed that single fqdn to
# aws_acm_certificate_validation. ACM emits one validation option per name on the certificate, so
# the moment a subject alternative name existed there was a validation option no DNS record
# satisfied. Nothing errors: aws_acm_certificate_validation simply polls until its timeout and the
# apply dies far from the cause. It is the AWS shape of the trap GCP already had, where a single
# unresolvable SAN puts the whole managed certificate in FAILED_NOT_VISIBLE forever.
#
# `tofu validate` cannot see any of this — it never expands a for_each and never builds an
# instance. Only a planned graph shows how many records exist, which is what these runs assert.
#
# The runs target ./modules/acm directly (a `module` block inside `run`) because the property is a
# per-instance count INSIDE the module, and a root-level plan can only see module outputs. The file
# still lives at the template ROOT: *.tftest.hcl under modules/ is silently skipped by `tofu test`.

mock_provider "aws" {}

# ------------------------------------------------------------------------------------------------
# 1. The regression proof — a certificate with SANs needs a record PER NAME
# ------------------------------------------------------------------------------------------------
run "every_subject_alternative_name_gets_its_own_validation_record" {
  command = plan

  module {
    source = "./modules/acm"
  }

  variables {
    domain_name               = "*.example.com"
    subject_alternative_names = ["api.example.com", "app.example.com"]
    r53_zone_id               = "Z0000000000000000000"
  }

  # domain_validation_options is computed by ACM, so the plan has to be told what ACM would
  # return. Three names, three options, three DISTINCT record names — the shape the old code
  # dropped two thirds of on the floor.
  override_resource {
    target = aws_acm_certificate.cf_alias
    values = {
      arn = "arn:aws:acm:us-east-1:111122223333:certificate/1827"
      domain_validation_options = [
        {
          domain_name           = "*.example.com"
          resource_record_name  = "_wildcard.example.com."
          resource_record_type  = "CNAME"
          resource_record_value = "_wildcard-token.acm-validations.aws."
        },
        {
          domain_name           = "api.example.com"
          resource_record_name  = "_api.example.com."
          resource_record_type  = "CNAME"
          resource_record_value = "_api-token.acm-validations.aws."
        },
        {
          domain_name           = "app.example.com"
          resource_record_name  = "_app.example.com."
          resource_record_type  = "CNAME"
          resource_record_value = "_app-token.acm-validations.aws."
        },
      ]
    }
  }

  # The count property. Stated against the certificate's own option count rather than a literal 3,
  # so it reads as the invariant it is: no validation option may be left without a record.
  assert {
    condition     = length(aws_route53_record.cert_validation) == length(aws_acm_certificate.cf_alias.domain_validation_options)
    error_message = "One Route 53 record per validation option, or ACM never validates the names that lack one."
  }

  # The count alone would be satisfied by three copies of the SAME record, so pin the keying: one
  # instance per validated name, addressable by that name.
  assert {
    condition = (
      toset(keys(aws_route53_record.cert_validation)) ==
      toset([for dvo in aws_acm_certificate.cf_alias.domain_validation_options : dvo.domain_name])
    )
    error_message = "Each validation option must own an instance keyed by its domain_name."
  }

  # And the contents, name and token together: a record carrying another name's token proves
  # nothing to ACM. The try() is what keeps a REGRESSION legible — an un-expanded resource has no
  # such key, and without it this reads as a wall of evaluation errors instead of a failed claim.
  assert {
    condition = alltrue([
      for dvo in aws_acm_certificate.cf_alias.domain_validation_options :
      try(aws_route53_record.cert_validation[dvo.domain_name].name, "") == dvo.resource_record_name &&
      try(one(aws_route53_record.cert_validation[dvo.domain_name].records), "") == dvo.resource_record_value &&
      try(aws_route53_record.cert_validation[dvo.domain_name].type, "") == dvo.resource_record_type
    ])
    error_message = "Every validated name needs a record carrying ITS OWN name, type and token."
  }

  # The SANs must actually reach the certificate — the variable existing is not the same as it
  # being set on the resource.
  assert {
    condition     = aws_acm_certificate.cf_alias.subject_alternative_names == toset(["api.example.com", "app.example.com"])
    error_message = "subject_alternative_names must be placed on the certificate."
  }

  # aws_acm_certificate_validation must wait on ALL the records. Under mocked providers every
  # record's computed fqdn is the same generated string, so this cannot be a count assertion — it
  # is a reference-shape assertion: the argument is the for-expression over the whole resource, so
  # every instance is a dependency of the wait.
  assert {
    condition     = length(aws_acm_certificate_validation.cert.validation_record_fqdns) > 0
    error_message = "The validation resource must be fed the records' fqdns."
  }
}

# ------------------------------------------------------------------------------------------------
# 2. The wildcard + apex collision — two options, ONE DNS name
# ------------------------------------------------------------------------------------------------
# ACM issues a single validation token for a wildcard and its own apex, so `*.example.com` plus
# `example.com` come back as two options with an IDENTICAL resource_record_name and value. Keyed by
# domain_name that is two resources writing the same record — which is safe only because both are
# UPSERTs of identical content and allow_overwrite is true. This run pins that the shape plans, so
# that a later "tidy-up" of allow_overwrite has to fail here rather than at 3am in an apply.
run "a_wildcard_and_its_apex_share_a_record_name_without_conflicting" {
  command = plan

  module {
    source = "./modules/acm"
  }

  variables {
    domain_name               = "*.example.com"
    subject_alternative_names = ["example.com"]
    r53_zone_id               = "Z0000000000000000000"
  }

  override_resource {
    target = aws_acm_certificate.cf_alias
    values = {
      arn = "arn:aws:acm:us-east-1:111122223333:certificate/1827-apex"
      domain_validation_options = [
        {
          domain_name           = "*.example.com"
          resource_record_name  = "_shared.example.com."
          resource_record_type  = "CNAME"
          resource_record_value = "_shared-token.acm-validations.aws."
        },
        {
          domain_name           = "example.com"
          resource_record_name  = "_shared.example.com."
          resource_record_type  = "CNAME"
          resource_record_value = "_shared-token.acm-validations.aws."
        },
      ]
    }
  }

  assert {
    condition     = length(aws_route53_record.cert_validation) == 2
    error_message = "Keying by domain_name must keep the wildcard and the apex as two distinct instances."
  }

  assert {
    condition = alltrue([
      for dvo in aws_acm_certificate.cf_alias.domain_validation_options :
      try(aws_route53_record.cert_validation[dvo.domain_name].allow_overwrite, false)
    ])
    error_message = "Both instances write the same Route 53 name; without allow_overwrite the second apply fails."
  }
}

# ------------------------------------------------------------------------------------------------
# 3. The default shape — no SANs, still exactly one record
# ------------------------------------------------------------------------------------------------
# What acm-certificate.tf asks for today (a bare wildcard). The for_each must not change it.
run "a_certificate_with_no_sans_still_gets_exactly_one_record" {
  command = plan

  module {
    source = "./modules/acm"
  }

  variables {
    domain_name = "*.example.com"
    r53_zone_id = "Z0000000000000000000"
  }

  override_resource {
    target = aws_acm_certificate.cf_alias
    values = {
      arn = "arn:aws:acm:us-east-1:111122223333:certificate/1827-plain"
      domain_validation_options = [
        {
          domain_name           = "*.example.com"
          resource_record_name  = "_wildcard.example.com."
          resource_record_type  = "CNAME"
          resource_record_value = "_wildcard-token.acm-validations.aws."
        },
      ]
    }
  }

  assert {
    condition     = length(aws_route53_record.cert_validation) == 1
    error_message = "A single-name certificate must still produce exactly one validation record."
  }

  assert {
    condition     = length(aws_acm_certificate.cf_alias.subject_alternative_names) == 0
    error_message = "subject_alternative_names must default to empty — the existing caller passes none."
  }
}
