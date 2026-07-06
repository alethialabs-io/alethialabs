// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"fmt"
	"os"
)

func ActivateAzureFederated(tenantID, clientID, subscriptionID string) (func(), error) {
	if tenantID == "" || clientID == "" {
		return nil, fmt.Errorf("missing Azure tenant_id or client_id")
	}

	os.Setenv("AZURE_TENANT_ID", tenantID)
	os.Setenv("AZURE_CLIENT_ID", clientID)
	os.Setenv("AZURE_SUBSCRIPTION_ID", subscriptionID)
	os.Setenv("AZURE_FEDERATED_TOKEN_FILE", "")

	cleanup := func() {
		os.Unsetenv("AZURE_TENANT_ID")
		os.Unsetenv("AZURE_CLIENT_ID")
		os.Unsetenv("AZURE_SUBSCRIPTION_ID")
		os.Unsetenv("AZURE_FEDERATED_TOKEN_FILE")
	}

	return cleanup, nil
}
