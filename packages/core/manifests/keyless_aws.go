// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import "fmt"

// awsAuthProxyWiring — RDS IAM auth. The app connects to a local `alethia db-authproxy` sidecar,
// which mints an RDS auth token from the pod's IRSA role per upstream connection and presents it as
// the password over TLS. The KSA is IRSA-annotated with the RDS IAM role ARN, which is what makes the
// AWS SDK's default credential chain resolve inside the proxy.
//
// One sidecar, no volumes: the proxy keeps the token in memory, so the previous `db-token` refresher
// and its shared emptyDir are gone.
//
// Fails CLOSED on any missing tofu output — a proxy pointed at an empty endpoint, or minting tokens
// for an empty region, would fail at connect time instead of at deploy time.
func awsAuthProxyWiring(opts Options, engine string) (keylessWiring, error) {
	endpoint := opts.Outputs[endpointOutputKey(providerAWS, "database")]
	if endpoint == "" {
		return keylessWiring{}, fmt.Errorf("no rds_cluster_endpoint output for keyless RDS IAM auth")
	}
	region := opts.Outputs["aws_region"]
	if region == "" {
		return keylessWiring{}, fmt.Errorf("no aws_region output for the RDS auth-token proxy")
	}
	roleARN := opts.Outputs["rds_iam_auth_irsa_arn"]
	if roleARN == "" {
		return keylessWiring{}, fmt.Errorf("no rds_iam_auth_irsa_arn output for the keyless app IRSA identity")
	}
	if opts.RunnerImage == "" {
		return keylessWiring{}, fmt.Errorf("no runner image for the AWS db-authproxy sidecar")
	}
	return keylessWiring{
		sidecars:      []Sidecar{authProxySidecar(providerAWS, engine, endpoint, region, opts.RunnerImage)},
		saName:        keylessKSAName,
		saAnnotations: map[string]string{"eks.amazonaws.com/role-arn": roleARN},
	}, nil
}
