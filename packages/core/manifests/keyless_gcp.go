// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import "fmt"

// gcpProxyWiring — the native Cloud SQL Auth Proxy sidecar. It mints the Cloud SQL IAM token itself
// from the pod's Workload Identity, so there is no runner sidecar, no token file and no volume here;
// `db-authproxy` deliberately REFUSES --provider gcp and points at this proxy instead.
//
// The proxy image is engine-agnostic — --auto-iam-authn works for Postgres and MySQL alike, and only
// the listen port differs — so the engine is threaded through to the port rather than branching the
// wiring. Both gcp cells are open in keylessCells: #1505 landed the Cloud SQL MySQL IAM-auth flag
// (the UNDERSCORED `cloudsql_iam_authentication`), without which the proxy would render cleanly and
// then fail to authenticate against an instance whose IAM auth tofu never enabled.
func gcpProxyWiring(opts Options, engine string) (keylessWiring, error) {
	conn := opts.Outputs["cloud_sql_connection_name"]
	if conn == "" {
		return keylessWiring{}, fmt.Errorf("no cloud_sql_connection_name output for keyless Cloud SQL auth")
	}
	gsa := opts.Outputs["cloud_sql_app_gsa_email"]
	if gsa == "" {
		return keylessWiring{}, fmt.Errorf("no cloud_sql_app_gsa_email output for the keyless app Workload Identity")
	}
	portStr, portInt := enginePort(engine)
	return keylessWiring{
		sidecars: []Sidecar{{
			Name:  "cloudsql-proxy",
			Image: cloudSQLProxyImage,
			Args:  []string{"--private-ip", "--auto-iam-authn", "--port=" + portStr, conn},
			Ports: []int{portInt},
		}},
		saName:        keylessKSAName,
		saAnnotations: map[string]string{"iam.gke.io/gcp-service-account": gsa},
	}, nil
}
