// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ACM certificate acceptance scenario (#1773) — the PURE, reusable half. Deliberately UNTAGGED
// (like t2_secrets_xacct.go / t2_day2_offer.go) so `go mod tidy` sees its deps and the decide /
// snapshot / verdict logic is unit-tested WITHOUT a cloud (t2_acm_cert_pure_test.go).
//
// # What this proves
//
// That Alethia can issue a REAL, publicly-validated TLS certificate for a project, and that the
// certificate reaches the product rather than merely existing in AWS. The full bar cannot prove it
// — see the mutual exclusion below — so this is its own scenario.
//
// # Why a scenario at all, and not just flipping acm_certificate on in the max-config fixture
//
// ACM DNS validation searches for its CNAME in a PUBLICLY HOSTED zone. Creating a zone is not being
// delegated one, and until #2296's stable zone is delegated from Cloudflare nothing under
// e2e.alethialabs.io resolves for anybody. That is why maxconfig.go pins acm_certificate off.
//
// Given a delegated zone, the honest place for the proof is still NOT the full bar:
//
//   - ACM's validation ceiling is 72 HOURS and UNRECOVERABLE — on expiry the certificate is dead and
//     must be re-requested, not retried.
//   - Its re-check cadence is undocumented, so there is nothing to design a wait around.
//   - The parent zone's negative-cache window is min(SOA MINIMUM, SOA TTL) — measured 1800/1800 on
//     alethialabs.io, so 30 minutes — and RFC 8020 lets one NXDOMAIN blank a whole subtree.
//
// None of that belongs on the critical path of a run that also has to prove ten other kinds.
//
// # ⚠️ MUTUALLY EXCLUSIVE WITH THE FULL BAR, BY CONSTRUCTION
//
// maxconfig.go's `dns` kind declares AWS: tofuCell("aws_route53_zone", "cloud_dns_enabled") and
// t2_provision_test.go hard-fails on any Missing kind. This scenario BRINGS a zone id, which makes
// cloud_dns_enabled false (aws_provider.go: `config.DNS.Enabled && config.DNS.ZoneID == ""`), so no
// aws_route53_zone is created and the `dns` kind would report Missing.
//
// decide() therefore REFUSES to run alongside ALETHIA_E2E_MAX_CONFIG rather than quietly weakening
// the cell to accept either signal. The full bar keeps proving the native-zone path; this scenario
// proves the brought-zone + certificate path; each proves something real, on its own night.
//
// # Why a brought zone needs no template change at all
//
// acm-certificate.tf already routes:
//
//	r53_zone_id = var.cloud_dns_enabled ? module.route53[0].zone_id : var.dns_hosted_zone
//
// so a brought zone id sends the validation records straight into the delegated zone. And because
// that zone is authoritative for EVERYTHING under e2e.alethialabs.io, one delegation covers every
// run's subdomain — no per-run NS record, and no negative-cache exposure, because the zone name
// always exists.
package e2e

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"
)

const (
	envAcmCert         = "ALETHIA_E2E_ACM_CERT"           // truthy ⇒ enable
	envAcmCertZoneID   = "ALETHIA_E2E_ACM_CERT_ZONE_ID"   // the stable zone's id (infra/aws-oidc output)
	envAcmCertZoneName = "ALETHIA_E2E_ACM_CERT_ZONE_NAME" // e.g. e2e.alethialabs.io
	envAcmCertTimeout  = "ALETHIA_E2E_ACM_CERT_TIMEOUT"   // tuning knob; default below
	envAcmCertSummary  = "ALETHIA_E2E_ACM_CERT_SUMMARY"   // where the run half writes its verdict
)

// acmCertDefaultTimeout budgets ACM issuance against an already-delegated zone. Issuance itself is
// usually 2-5 minutes; the headroom is for the validation record's own propagation, not for the
// 72-hour ceiling, which no wait here could ever cover.
const acmCertDefaultTimeout = 20 * time.Minute

type acmCertConfig struct {
	provider   string
	enabled    bool
	zoneID     string
	zoneName   string
	domainName string
	// fullBar records whether the full-bar surface is also requested, so decide() can refuse the
	// combination with a reason instead of letting the `dns` kind fail obscurely later.
	// runEnv is ALETHIA_E2E_ENV as read, kept RAW so decide() can tell "unset" from a derived
	// default. domainName alone cannot: an empty env and a zone apex render identically.
	runEnv  string
	fullBar bool
}

func acmCertEnabled() bool { return t2Truthy(os.Getenv(envAcmCert)) }

// acmCertLane is the SINGLE source of truth for which clouds this scenario can prove, and why the
// others cannot — the same contract secretsXacctLane holds, read by the pure tests and the run half
// so a lane cannot rot in one place while looking green in another.
//
// This is AWS-only and that is a real ceiling, not deferred work: ACM is an AWS service. GCP and
// Azure issue TLS through cert-manager IN-CLUSTER (#1858 deleted GCP's managed-certificate
// resource outright), which is a different mechanism with a different proof, and Alibaba/Hetzner
// have no managed-certificate output at all.
func acmCertLane(provider string) (ok bool, blocked string) {
	switch provider {
	case "aws":
		return true, ""
	case "gcp":
		return false, "GCP: TLS is issued in-cluster by cert-manager, not by a cloud certificate resource — #1858 deleted google_compute_managed_ssl_certificate and the pre-shared-cert annotation that named it, so there is no cloud-side certificate for this scenario to assert."
	case "azure":
		return false, "Azure: TLS is issued in-cluster by cert-manager, the same convergence GCP made — an Application Gateway certificate is a different product surface and is not what the template builds."
	case "alibaba", "hetzner":
		return false, fmt.Sprintf("%s: no managed-certificate resource in the template, and no certificate output for the product to consume.", provider)
	default:
		return false, fmt.Sprintf("%s has no managed certificate path.", provider)
	}
}

// acmCertDomain is the run-scoped name the certificate covers. It mirrors MaxConfigDomain so two
// concurrent legs never write the same validation record into the SHARED, long-lived zone — the one
// piece of cross-run mutable state this scenario has.
func acmCertDomain(env, zoneName string) string {
	env = strings.TrimSpace(env)
	zoneName = strings.TrimSuffix(strings.TrimSpace(zoneName), ".")
	if zoneName == "" {
		return ""
	}
	if env == "" {
		return zoneName
	}
	return env + "." + zoneName
}

// acmCertFromEnv resolves the scenario config. It reads ALETHIA_E2E_ENV itself rather than taking
// it as an argument, mirroring MaxConfigDomain — the driver resolves this BEFORE it derives its own
// env name, and the run-scoped domain must agree with the one the deploy actually used.
func acmCertFromEnv(provider string) acmCertConfig {
	zoneName := strings.TrimSpace(os.Getenv(envAcmCertZoneName))
	env := strings.TrimSpace(os.Getenv("ALETHIA_E2E_ENV"))
	return acmCertConfig{
		provider:   provider,
		enabled:    acmCertEnabled(),
		zoneID:     strings.TrimSpace(os.Getenv(envAcmCertZoneID)),
		zoneName:   zoneName,
		domainName: acmCertDomain(env, zoneName),
		runEnv:     env,
		fullBar:    MaxConfigEnabled(),
	}
}

// decide reports whether to run, why it is skipped, or that the request is unusable.
//
//	not requested            → (false, "",     nil)  silent
//	not requested + full bar → (false, reason, nil)  LOGGED — withheld, not merely absent
//	requested, lane BLOCKED  → (false, reason, nil)  logged, no spend
//	requested, half-wired    → (false, "",     err)  HARD FAIL naming every missing key
//	requested + full bar     → (false, "",     err)  HARD FAIL — mutually exclusive, see the header
func (c acmCertConfig) decide() (bool, string, error) {
	if !c.enabled {
		// NOT SILENT WHEN MAX-CONFIG IS ON, and the reason is four lines below: the fullBar arm
		// refuses LOUDLY precisely "because a silent skip here would look like the cert was proven
		// on a night the full bar ran".
		//
		// #2630 made that refusal unreachable on the path it was written for. It withholds
		// ALETHIA_E2E_ACM_CERT on a max-config dimension — correctly, because the variable is set on
		// every run and `full` sets MAX_CONFIG by definition, so the hard failure made two of aws's
		// five cells permanently unrunnable. But withholding the variable lands here, in the branch
		// meant for "nobody asked for this", and says nothing at all. The rule survived; the
		// announcement did not.
		//
		// So this is the third outcome the table lacked: not requested, not refused, WITHHELD. The
		// wording covers both readings of the same state — deliberately withheld by the workflow, or
		// never configured in this repo at all — because the env cannot tell them apart and the
		// consequence is identical: the certificate was not proven on this run.
		if c.fullBar {
			return false, "not attempted on a max-config dimension. The two are mutually exclusive — this scenario " +
				"brings a zone id, which makes cloud_dns_enabled false, so the max-config `dns` kind would report " +
				"Missing — and e2e-nightly.yml withholds " + envAcmCert + " here for that reason. The certificate " +
				"was NOT proven by this run; prove it on a floor night", nil
		}
		return false, "", nil
	}
	if ok, blocked := acmCertLane(c.provider); !ok {
		return false, blocked, nil
	}
	// Refused LOUDLY rather than skipped, because a silent skip here would look like the cert was
	// proven on a night the full bar ran. See the mutual-exclusion note in the file header.
	if c.fullBar {
		return false, "", fmt.Errorf(
			"%s and ALETHIA_E2E_MAX_CONFIG cannot both be set: this scenario brings a zone id, which makes "+
				"cloud_dns_enabled false, so no aws_route53_zone is created and the max-config `dns` kind reports "+
				"Missing. Run the certificate proof on a floor night; the full bar proves the native-zone path",
			envAcmCert)
	}
	var missing []string
	if c.zoneID == "" {
		missing = append(missing, envAcmCertZoneID)
	}
	if c.zoneName == "" {
		missing = append(missing, envAcmCertZoneName)
	}
	if len(missing) > 0 {
		return false, "", fmt.Errorf(
			"%s is set but %s missing — the certificate validates into a PRE-DELEGATED zone, so both the "+
				"zone id and its name are required (see infra/aws-oidc/e2e-dns.tf outputs)",
			envAcmCert, strings.Join(missing, ", "))
	}
	// REFUSE the zone apex (#2566, finding 5). acmCertDomain falls back to the bare zone name when
	// ALETHIA_E2E_ENV is empty, and that fallback became reachable the moment this scenario was
	// actually wired: the driver derives its own env as `local<hex>` when the variable is unset, so a
	// manual or local run with E2E_ACM_CERT set would provision env `local<hex>` while requesting a
	// certificate for `*.<zone>` and writing the validation record UN-SCOPED into the shared,
	// long-lived zone.
	//
	// acmCertDomain's own comment says the run-scoping exists "so two concurrent legs never write the
	// same validation record into the SHARED zone" — the fallback silently removes exactly that. The
	// nightly always sets ALETHIA_E2E_ENV, so this refuses the operator's mistake, never CI's normal
	// path. Loud, because a silent apex certificate is indistinguishable from a correct one until two
	// runs collide.
	if c.runEnv == "" {
		return false, "", fmt.Errorf(
			"%s is set but ALETHIA_E2E_ENV is empty — the domain would fall back to the zone apex %q and write an "+
				"UN-SCOPED validation record into the shared zone, which is what run-scoping exists to prevent. "+
				"Export ALETHIA_E2E_ENV (the nightly always does)",
			envAcmCert, c.zoneName)
	}
	if c.domainName == "" {
		return false, "", fmt.Errorf("%s: could not derive a domain name from %s=%q", envAcmCert, envAcmCertZoneName, c.zoneName)
	}
	return true, "", nil
}

// applyToSnapshot REPLACES the dns block rather than appending to it.
//
// Every other scenario appends to a disjoint key. This one cannot: MaxConfigSnapshot ASSIGNS
// snap["dns"] wholesale from the max-config fixture, and the two configurations are contradictory
// by construction (a brought zone versus a created one). So this must run AFTER MaxConfigSnapshot,
// and decide() refuses the combination anyway — this assignment is what the floor path uses.
func (c acmCertConfig) applyToSnapshot(snap map[string]any) {
	if snap == nil {
		return
	}
	snap["dns"] = map[string]any{
		"enabled":     true,
		"zone_id":     c.zoneID,
		"domain_name": c.domainName,
		// Both halves are load-bearing and the pure tests assert both: zone_id makes
		// cloud_dns_enabled false (so validation lands in the delegated zone), and acm_certificate
		// is what builds the certificate at all. Either alone proves nothing.
		"provider_config": map[string]any{"acm_certificate": true},
	}
}

func acmCertTimeout() time.Duration {
	if v := strings.TrimSpace(os.Getenv(envAcmCertTimeout)); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return acmCertDefaultTimeout
}

// acmCertARNPattern is deliberately strict about the resource segment: an ACM certificate ARN is
// `arn:aws:acm:<region>:<account>:certificate/<uuid>`. A loose check would accept the IAM server
// certificate ARN an ALB can also carry, which is a different object entirely.
var acmCertARNPattern = regexp.MustCompile(`^arn:aws[a-z-]*:acm:[a-z0-9-]+:\d{12}:certificate/[0-9a-f-]{36}$`)

func isACMCertARN(s string) bool { return acmCertARNPattern.MatchString(strings.TrimSpace(s)) }

// parseACMCertARN pulls the certificate ARN out of the deploy job's execution_metadata. Absent is
// not an error at this layer — the caller decides whether absence is fatal — but a PRESENT value
// that is not an ACM ARN is, because that means something else claimed the field.
func parseACMCertARN(metaRaw []byte) (string, error) {
	if len(metaRaw) == 0 {
		return "", nil
	}
	var meta map[string]any
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		return "", fmt.Errorf("execution_metadata is not JSON: %w", err)
	}
	for _, key := range []string{"acm_certificate_arn", "acmCertificateArn"} {
		v, ok := meta[key]
		if !ok {
			continue
		}
		s, ok := v.(string)
		if !ok || strings.TrimSpace(s) == "" {
			continue
		}
		if !isACMCertARN(s) {
			return "", fmt.Errorf("execution_metadata.%s is not an ACM certificate ARN: %q", key, s)
		}
		return strings.TrimSpace(s), nil
	}
	return "", nil
}

type acmCertSummary struct {
	Feature    string `json:"feature"`
	Provider   string `json:"provider"`
	ZoneID     string `json:"zone_id"`
	DomainName string `json:"domain_name"`
	CertARN    string `json:"certificate_arn,omitempty"`
	// ZoneNotCreated is the non-vacuity control: the run brought a zone rather than making one.
	ZoneNotCreated bool   `json:"zone_not_created"`
	CertIssued     bool   `json:"certificate_issued"`
	IngressGated   bool   `json:"ingress_gated"`
	Verdict        string `json:"verdict"`
	Detail         string `json:"detail,omitempty"`
}

func acmCertVerdictPass(s acmCertSummary) bool {
	return s.ZoneNotCreated && s.CertIssued && isACMCertARN(s.CertARN)
}

func acmCertSummaryJSON(s acmCertSummary) ([]byte, error) {
	s.Feature = "acm-certificate"
	if s.Verdict == "" {
		if acmCertVerdictPass(s) {
			s.Verdict = "PASS"
		} else {
			s.Verdict = "FAIL"
		}
	}
	return json.MarshalIndent(s, "", "  ")
}
