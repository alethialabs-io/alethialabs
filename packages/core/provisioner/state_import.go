// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"

	"github.com/alethialabs-io/alethialabs/packages/core/categories"
	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/tofu"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// State import — the repair for an environment WEDGED by an orphaned resource (issue #526).
//
// A failed apply can leave a real cloud resource OUTSIDE tofu state: the cloud accepts the create,
// then fails it asynchronously, so tofu's create errors and never records it. Every later apply then
// dies with `already exists ... needs to be imported`, and (as seen on real Azure) even `destroy` can
// fail — the environment is stuck until someone reconciles it. ClassifyApplyError (orphan.go) already
// hands us the two things a repair needs: the tofu ADDRESS and the CLOUD ID.
//
// WHY IMPORT AND NOT DELETE. Import is the only remedy that is SAFE on a LIVE environment: it merely
// brings an existing resource under management and can destroy nothing. The pre-existing break-glass
// `orphan_clean` action is the wrong shape for this — it is a cross-cloud FORCE-DESTROY (shipped
// inert) aimed at leftovers of an environment that is already GONE; pointing it at a live env could
// take out a customer's database. Import is also, literally, the remedy the provider names.
//
// After a successful import the environment is UNWEDGED: the next plan/apply sees the resource in
// state and can update, replace or destroy it through the normal path.
//
// This runs through the SAME http state backend as deploy/drift, so the state lock and fencing stay
// intact — it is never a raw state write.

// ImportParams describes a single orphan → state repair.
type ImportParams struct {
	ProjectConfig *types.ProjectConfig
	Provider      string
	TemplatesDir  string
	CategoriesDir string
	// StateBackend is the console's per-job http state proxy — the same backend RunDeployV2 writes,
	// so the import takes the state lock and fencing is preserved. Required.
	StateBackend *cloud.HTTPBackendConfig

	// Address is the tofu resource address to import into, e.g.
	// module.azure_cache[0].azurerm_managed_redis.this. Comes from OrphanFinding.Address.
	Address string
	// CloudID is the provider's id for the existing resource. Comes from OrphanFinding.CloudID.
	CloudID string

	Stdout io.Writer
	Stderr io.Writer

	// GitAccessToken authorizes a BYO IaC clone (the module must be the one that owns the address).
	GitAccessToken string
}

// ImportResult reports what the repair actually achieved.
type ImportResult struct {
	Address string
	CloudID string
	// Imported is true only when the address is PRESENT in tofu state after the import — verified by
	// reading the state back, not assumed from a zero exit code.
	Imported bool
}

// RunStateImport imports an orphaned cloud resource into tofu state, unwedging the environment.
//
// It VERIFIES the outcome by reading state back and confirming the address is now tracked — a repair
// that silently no-ops would leave the environment just as stuck, so success is proven, not assumed.
func RunStateImport(ctx context.Context, params ImportParams) (*ImportResult, error) {
	vc := params.ProjectConfig
	if vc == nil {
		return nil, fmt.Errorf("ProjectConfig is required for RunStateImport")
	}
	if params.StateBackend == nil {
		return nil, fmt.Errorf("StateBackend config is required for state access")
	}
	if params.Address == "" || params.CloudID == "" {
		return nil, fmt.Errorf("both a resource address and a cloud id are required (got address=%q id=%q) — these come from the failed apply's orphan finding", params.Address, params.CloudID)
	}
	byoIac := vc.IacSource != nil
	if !byoIac && params.TemplatesDir == "" {
		return nil, fmt.Errorf("TemplatesDir is required")
	}

	provider, err := cloud.NewCloudProvider(params.Provider)
	if err != nil {
		return nil, err
	}

	stdout := params.Stdout
	if stdout == nil {
		stdout = os.Stdout
	}
	stderr := params.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}

	tmpRoot, err := os.MkdirTemp("", "alethia-import-*")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpRoot)

	// The workspace must be the SAME configuration that owns the address, or the address will not
	// resolve. Mirror the deploy/drift workdir exactly.
	var tfDir string
	var tfvars map[string]interface{}
	if byoIac {
		token := params.GitAccessToken
		if token == "" {
			token = vc.GitAccessToken
		}
		cloneDir := filepath.Join(tmpRoot, "clone")
		var restore func()
		tfDir, tfvars, restore, err = prepareByoIacWorkdir(vc, token, cloneDir, stdout, stderr)
		if err != nil {
			return nil, err
		}
		defer restore()
	} else {
		tfDir = filepath.Join(tmpRoot, "work")
		if err := copyDir(params.TemplatesDir, tfDir); err != nil {
			return nil, fmt.Errorf("failed to copy templates: %w", err)
		}
		tfvars = provider.ProviderTfvars(vc)
		if _, composeErr := categories.Compose(tfDir, params.CategoriesDir, vc, tfvars, stdout); composeErr != nil {
			return nil, fmt.Errorf("connector composition failed: %w", composeErr)
		}
	}

	tf, err := tofu.NewTofuCLI(ctx, vc.IacVersion, tfDir, stdout, stderr)
	if err != nil {
		return nil, fmt.Errorf("tofu init failed: %w", err)
	}

	if _, err := tofu.OverrideTfvarsFromMap(tfDir, tfvars); err != nil {
		return nil, fmt.Errorf("failed to write tfvars: %w", err)
	}

	backendFile, err := params.StateBackend.WriteBackendHCL(tfDir)
	if err != nil {
		return nil, fmt.Errorf("failed to write backend config: %w", err)
	}

	restoreStateAuth := params.StateBackend.SetAuthEnv()
	defer restoreStateAuth()
	if err := tf.InitWithBackendFile(ctx, backendFile, false); err != nil {
		return nil, fmt.Errorf("tofu init failed: %w", err)
	}

	fmt.Fprintf(stdout, "Reconciling orphan into state: %s (cloud id %s)\n", params.Address, params.CloudID)
	if err := tf.Import(ctx, params.Address, params.CloudID); err != nil {
		return nil, fmt.Errorf("tofu import of %s failed: %w", params.Address, err)
	}

	// VERIFY. A zero exit code is not proof — read the state back and confirm the address is tracked.
	// If it is not, the environment is still wedged and we must say so rather than report success.
	addrs, err := tf.StateResources(ctx)
	if err != nil {
		return nil, fmt.Errorf("import ran but state could not be read back to verify it: %w", err)
	}
	imported := slices.Contains(addrs, params.Address)
	if !imported {
		return &ImportResult{Address: params.Address, CloudID: params.CloudID, Imported: false},
			fmt.Errorf("tofu import reported success but %s is NOT present in state — the environment is still wedged", params.Address)
	}

	fmt.Fprintf(stdout, "Imported %s into state — the environment is no longer wedged; the next plan/apply can manage this resource normally.\n", params.Address)
	return &ImportResult{Address: params.Address, CloudID: params.CloudID, Imported: true}, nil
}
