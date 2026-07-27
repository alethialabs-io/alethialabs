// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import "fmt"

// azureAuthProxyWiring — Entra auth, both engines. The app connects to a local `alethia db-authproxy`
// sidecar, which mints an Entra token from the pod's federated identity per upstream connection and
// presents it as the password over TLS. The ossrdbms-aad scope is shared by Flexible Server Postgres
// and MySQL, so one minter serves both cells; only the wire port and protocol differ, and the proxy
// selects those from --engine.
//
// One sidecar, no volumes (the token never touches disk).
//
// The KSA carries the Azure Workload-Identity label + client-id annotation, AND the same label is
// returned as a POD label: the azure-workload-identity webhook injects AZURE_FEDERATED_TOKEN_FILE
// only into pods that carry `azure.workload.identity/use`, so labelling the ServiceAccount alone
// leaves the proxy with no identity to mint from. The bootstrap Job already does this (its PodLabels);
// the app Deployment did not, which is why keyless on Azure could not authenticate at all.
func azureAuthProxyWiring(opts Options, engine string) (keylessWiring, error) {
	fqdn := opts.Outputs["azure_db_fqdn"]
	if fqdn == "" {
		return keylessWiring{}, fmt.Errorf("no azure_db_fqdn output for keyless Entra auth")
	}
	clientID := opts.Outputs["azure_db_client_id"]
	if clientID == "" {
		return keylessWiring{}, fmt.Errorf("no azure_db_client_id output for the keyless app federated identity")
	}
	if opts.RunnerImage == "" {
		return keylessWiring{}, fmt.Errorf("no runner image for the Azure db-authproxy sidecar")
	}
	// No --region: the Entra token is not region-signed.
	return keylessWiring{
		sidecars:      []Sidecar{authProxySidecar(providerAzure, engine, fqdn, "", opts.RunnerImage)},
		saName:        keylessKSAName,
		saLabels:      map[string]string{azureWorkloadIdentityLabel: "true"},
		saAnnotations: map[string]string{"azure.workload.identity/client-id": clientID},
		podLabels:     map[string]string{azureWorkloadIdentityLabel: "true"},
	}, nil
}
