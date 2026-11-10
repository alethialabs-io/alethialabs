// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// This file decides how the database bootstrap Jobs (RenderBootstrapJob, RenderByoDBUsersJob) verify
// the managed database server they send an administrator credential to (#6521). Both Jobs used to
// connect with `--ssl-mode=REQUIRED` / `sslmode=require`, which encrypt the connection but accept any
// certificate, so anything that answered on the server's address received the credential.
//
// Per cloud, the client now checks the server's certificate against a CA set that reaches the pod as
// a mounted ConfigMap (never a run-time download), and on AWS and Azure also checks the host name:
//
//   - AWS (Aurora, rds_cluster_endpoint): VERIFY_IDENTITY / verify-full against the RDS global bundle
//     (dbca/aws-rds-global-bundle.crt). The Aurora docs state that a client which reads Subject
//     Alternative Names can verify the cluster endpoint against the certificate (both clients here,
//     mysql 8 and libpq 16, do), and that the global bundle carries the RDS root CAs
//     (rds-ca-rsa2048-g1, the default, plus rds-ca-rsa4096-g1 and rds-ca-ecc384-g1) for any
//     commercial Region. GovCloud has its own bundle; no region list in this repository offers it.
//   - Azure (flexible server, azure_db_fqdn): VERIFY_IDENTITY / verify-full against
//     dbca/azure-db-roots.crt: DigiCert Global Root G2 and Microsoft RSA Root Certificate Authority
//     2017, which the current certificates chain to, and DigiCert Global Root CA, which Microsoft says
//     to keep until a server has moved off it. The Job connects by the server's own FQDN
//     (<server>.mysql|postgres.database.azure.com), the name Microsoft documents for full verification.
//   - GCP (Cloud SQL, cloud_sql_ip): VERIFY_CA / verify-ca against the INSTANCE's own server CA
//     (cloud_sql_server_ca_cert). The Job connects by private IP, and a per-instance-CA server
//     certificate carries a host name only when Private Service Connect is enabled, which these
//     instances do not use, so a host-name check cannot pass. It is also not needed there: Google
//     documents that verifying the CA verifies the server's identity, because each instance has a
//     unique CA. That holds only for the per-instance CA mode, so any other mode
//     (cloud_sql_server_ca_mode, a shared or customer-managed CA, where Google says the host name
//     must also be checked) is refused rather than verified by CA alone. An absent mode is read as the
//     per-instance CA: Google documents it as the default for instances Terraform creates, and the
//     template (infra/templates/project/gcp/modules/cloud-sql) sets no other.
//
// Every mode fails closed: the client refuses a certificate that does not verify, the Job fails, and
// there is no retry without verification. dbTLSFailureReason names the cause in the pod log and the
// container's termination message.
package manifests

import (
	"crypto/x509"
	_ "embed"
	"encoding/pem"
	"fmt"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"gopkg.in/yaml.v3"
)

// The checked-in CA bundles. dbca/SOURCES.json pins each one's upstream URLs and sha256
// (TestDBCABundles_MatchTheirPins); scripts/db-ca-bundles.sh rebuilds them and checks upstream.
var (
	//go:embed dbca/aws-rds-global-bundle.crt
	awsRDSCABundle string
	//go:embed dbca/azure-db-roots.crt
	azureDBCABundle string
)

const (
	// dbCAVolume is the pod volume (a ConfigMap) holding the CA set; dbCADir is where it is mounted
	// and dbCAFile the file the clients read (dbCAKey is its ConfigMap key).
	dbCAVolume = "db-ca"
	dbCADir    = "/etc/alethia/db-ca"
	dbCAKey    = "ca.pem"
	dbCAFile   = dbCADir + "/" + dbCAKey

	// dbTLSReasonEnv carries dbTLSFailureReason into the apply container, as a YAML-quoted env value
	// rather than shell text, so nothing in it is ever parsed by the shell.
	dbTLSReasonEnv = "ALETHIA_DB_TLS_REASON"

	// gcpServerCACertOutput / gcpServerCAModeOutput are the Cloud SQL tofu outputs the GCP CA comes
	// from (infra/templates/project/gcp/outputs.tf).
	gcpServerCACertOutput = "cloud_sql_server_ca_cert"
	gcpServerCAModeOutput = "cloud_sql_server_ca_mode"
	// gcpPerInstanceCAMode is the only Cloud SQL server CA mode in which verifying the CA alone
	// identifies the instance.
	gcpPerInstanceCAMode = "GOOGLE_MANAGED_INTERNAL_CA"
)

// dbTLS is how one Job verifies its database server: whether the host name is checked as well as the
// CA (Identity), the CA set (CAPEM) and a short name for it in the failure reason (Source).
type dbTLS struct {
	Identity bool
	CAPEM    string
	Source   string
}

// MySQLFlags are the mysql client's TLS options: verification mode and the mounted CA file.
func (t dbTLS) MySQLFlags() string {
	mode := "VERIFY_CA"
	if t.Identity {
		mode = "VERIFY_IDENTITY"
	}
	return "--ssl-mode=" + mode + " --ssl-ca=" + dbCAFile
}

// PGSSLMode is libpq's sslmode for this verification.
func (t dbTLS) PGSSLMode() string {
	if t.Identity {
		return "verify-full"
	}
	return "verify-ca"
}

// dbTLSFailureReason is the line a Job prints, and writes as its termination message, when the
// database client fails with a TLS error: it names the check that was made and states that there is
// no unverified retry.
func (t dbTLS) dbTLSFailureReason() string {
	check := "the CA"
	if t.Identity {
		check = "the CA and the host name"
	}
	return "alethia: DB_TLS_VERIFY_FAILED: the database server's TLS certificate did not verify (" + check +
		" checked against " + t.Source + "). The Job stops here; it never retries without verification."
}

// dbTLSFor resolves the verification for one cloud's managed database from the provision's tofu
// outputs. It fails closed: an unknown provider, a missing or unparseable GCP server CA, or a Cloud SQL
// CA mode in which the CA alone does not identify the instance is an error, never a weaker mode.
func dbTLSFor(provider string, outputs map[string]string) (dbTLS, error) {
	switch provider {
	case string(types.CloudProviderAws):
		return dbTLS{Identity: true, CAPEM: awsRDSCABundle, Source: "the Amazon RDS global CA bundle"}, nil
	case string(types.CloudProviderAzure):
		return dbTLS{Identity: true, CAPEM: azureDBCABundle, Source: "the Azure Database root CAs"}, nil
	case string(types.CloudProviderGcp):
		switch mode := outputs[gcpServerCAModeOutput]; mode {
		case "", gcpPerInstanceCAMode:
		default:
			return dbTLS{}, fmt.Errorf("the Cloud SQL instance uses server CA mode %s; the bootstrap Job connects by private IP and can verify only an instance with its own CA (%s), so it will not connect", mode, gcpPerInstanceCAMode)
		}
		ca := outputs[gcpServerCACertOutput]
		if err := checkCAPEM(ca); err != nil {
			return dbTLS{}, fmt.Errorf("no usable %s output to verify the Cloud SQL server against: %w", gcpServerCACertOutput, err)
		}
		return dbTLS{Identity: false, CAPEM: ca, Source: "the Cloud SQL instance's server CA"}, nil
	}
	return dbTLS{}, fmt.Errorf("no database TLS verification is defined for provider %q", provider)
}

// checkCAPEM reports whether s is one or more PEM certificates, each of which parses, and nothing
// else. An empty string, stray text or a non-certificate block is refused, so the client is never
// handed a CA file that verifies nothing.
func checkCAPEM(s string) error {
	rest := []byte(strings.TrimSpace(s))
	if len(rest) == 0 {
		return fmt.Errorf("it is empty")
	}
	n := 0
	for len(rest) > 0 {
		block, r := pem.Decode(rest)
		if block == nil {
			return fmt.Errorf("it holds text that is not a PEM block")
		}
		if block.Type != "CERTIFICATE" {
			return fmt.Errorf("it holds a %s block, not a certificate", block.Type)
		}
		if _, err := x509.ParseCertificate(block.Bytes); err != nil {
			return fmt.Errorf("certificate %d does not parse: %w", n+1, err)
		}
		n++
		rest = []byte(strings.TrimSpace(string(r)))
	}
	return nil
}

// dbTLSShellPrelude is the shell both Jobs' apply containers start with. run_db_client runs a
// database client with its stdout on fd 3 (which the caller opens) and its stderr captured; it
// prints that stderr, and when the client failed with one of its TLS verification errors it also
// prints the TLS failure reason and writes it as the termination message. It returns the client's
// exit code unchanged, so the classification only ever ADDS a reason to a failure: it can never turn
// one into a success, and a failure it does not recognise still fails.
//
// The match is on the clients' own TLS error texts, not on the words SSL, TLS or certificate, so a
// failure that merely mentions them (an SQL error naming a role, require_secure_transport refusing a
// plaintext connection) is not given the TLS reason:
//
//   - mysql: CR_SSL_CONNECTION_ERROR, "ERROR 2026 (HY000): SSL connection error: …" — an untrusted
//     chain, a host-name mismatch under VERIFY_IDENTITY, or an unreadable CA file;
//   - libpq: "SSL error: …" (e.g. certificate verify failed), `server certificate for "…" does not
//     match host name "…"`, and `root certificate file "…" does not exist` / `could not read root
//     certificate file`.
//
// db_tls_integration_test.go asserts the reason on every refusal against real servers, so a client
// whose wording drifts from these turns that test red rather than losing the reason silently.
const dbTLSShellPrelude = `set -eu
run_db_client() {
  rc=0
  err="$("$@" 2>&1 >&3)" || rc=$?
  if [ -n "$err" ]; then printf '%s\n' "$err" >&2; fi
  if [ "$rc" -ne 0 ]; then
    case "$err" in
      *"SSL connection error"*|*"SSL error:"*|*"does not match host name"*|*"root certificate file"*)
        printf '%s\n' "$` + dbTLSReasonEnv + `" >&2
        printf '%s\n' "$` + dbTLSReasonEnv + `" > /dev/termination-log 2>/dev/null || true
        ;;
    esac
  fi
  return "$rc"
}
`

// dbCAConfigMapName is the CA ConfigMap of a Job (or run) named stem.
func dbCAConfigMapName(stem string) string { return stem + "-db-ca" }

// renderDBCAConfigMap renders the ConfigMap holding a Job's CA set. Marshalled, not templated, so the
// PEM is quoted as YAML needs whatever it contains. The AWS bundle is ~175 KB: inside the 256 KB that
// a client-side `kubectl apply` (and ArgoCD's default apply) can record in its last-applied annotation,
// and far inside a ConfigMap's 1 MiB.
func renderDBCAConfigMap(name, namespace string, labels, annotations map[string]string, t dbTLS) string {
	meta := map[string]any{"name": name, "namespace": namespace, "labels": labels}
	if len(annotations) > 0 {
		meta["annotations"] = annotations
	}
	b, _ := yaml.Marshal(map[string]any{
		"apiVersion": "v1",
		"kind":       "ConfigMap",
		"metadata":   meta,
		"data":       map[string]string{dbCAKey: t.CAPEM},
	})
	return string(b)
}
