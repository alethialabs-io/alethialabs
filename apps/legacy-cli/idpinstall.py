#!./venv/bin/python3
"""
CURRENT LOCAL USAGE
set access key and secret in ~/.aws/credentials

python3 -m venv venv
source ./venv/bin/activate
pip3 install -r requirements.txt
deactivate

./index.py --awsprofile=itgix
"""

#IMPORT SYSTEM LIBS
import threading
import time
import os
import traceback
import json

#IMPORT CUSTOM MODULES
from modules.aws import AWS
from modules.config import CONFIG
from modules.terraform import TERRAFORM
from modules.infracost import INFRACOST
from modules.pulumi import PULUMI
from modules.validator import VALIDATOR
from modules.logs import LOGS
from modules.colors import PCOLORS
from modules.git_utils import GIT
from modules.k8s import K8S
from modules.helm import HELM
from modules.state import IDPSTATE
from modules.dataclasses import *
from modules.arg_parser import parse_args

#INIT
argvs = parse_args()
myCONFIG = CONFIG(argvs.config_file)
myTERRAFORM = TERRAFORM()
myINFRACOST = INFRACOST()
myPULUMI = PULUMI()
myVALIDATOR = VALIDATOR()
myLOGS = LOGS()
myCOLORS = PCOLORS()
myIDPSTATE = IDPSTATE()

def idpInitMain():
    # We assume the script fails, and set it to True if it doesn't
    script_success = False
    output = ""
    myLOGS.log("normal", "Start script.")
    colorStatus = myCOLORS.FAIL
    try:
        loading = threading.Thread(target=myCOLORS.animate)
        loading.start()

        #GENERATE VARIABLES - TODO
        myLOGS.log("debug", f'Generate variables')

        #CLEAN UP TEMP DIRS - TODO
        myLOGS.log("debug", f'Clean up temp folders')

        #GET ARGVS
        if argvs.dry_run:
            myLOGS.log("warn", "DRY RUN ENABLED")

        #READ CONFIG
        config = myCONFIG.read()
        myAWS = AWS(argvs.awsprofile, config.region, argvs.dry_run)
        myK8S = K8S(argvs.awsprofile, config.region, argvs.dry_run)
        myHelm = HELM(argvs.dry_run)

        #GET STATE
        myLOGS.log("info", "Getting state file...")
        stateBucket_name = f'{config.project_name}-{config.environment}-{config.region}-idp-state'
        stateBucket = BucketOptions(stateBucket_name, config.region)

        bucket_created = myAWS.s3_createBucket(stateBucket)

        if argvs.create_state_bucket_only:
            script_success = True
            exit()

        # TODO: Is this used at all?
        ##DOWNLOAD STATE FILE
        #ifStateFileExists = myAWS.s3_checkIfFileExists( stateBucket_name, 'template.yml' )
        #if ifStateFileExists:
        #    ifDownloadedFileState = myAWS.s3_getFile( stateBucket_name, 'template.yml', 'temp/temp.config' )
        #    if not ifDownloadedFileState:
        #        raise Exception("File can not be downloaded or saved!")

        #PROVIDE TERRAFORM BINARIES
        myLOGS.log("info", "Provisioning binaries...")
        myTERRAFORM.download( config.terraform_ver )
        #provision helm

        # TODO: Is this used at all?
        ##COMPARE MAGIC
        #if ifStateFileExists and ifDownloadedFileState:
        #    #compare config and state
        #    pass
        #else:
        #    #dont compare and apply as is
        #    pass

        # Bootstrap argocd repository
        myLOGS.log("info", "Cloning template repositories ...")
        argo_template_repo = GIT(config.gitops_template_repo, 'git/template_argo_repo',  argvs.dry_run)
        argo_client_repo = GIT(config.gitops_destination_repo, 'git/client_argo_repo',  argvs.dry_run)

        argo_template_repo.clone(branch=config.gitops_template_repo_branch,force=True)
        argo_client_repo.clone()

        # Bootstrap env repository
        template_repo = GIT(config.env_template_repo, 'git/template_repo', argvs.dry_run)
        client_repo = GIT(config.env_git_repo, 'git/client_repo', argvs.dry_run)
        template_repo.clone(branch=config.env_template_repo_branch, force=True)
        client_repo.clone()

        # Clone applications repo if specified in the config
        if config.applications_template_repo:
            applications_template_repo = GIT(config.applications_template_repo, 'git/template_applications_repo',  argvs.dry_run)
            applications_client_repo = GIT(config.applications_destination_repo, 'git/client_applications_repo',  argvs.dry_run)

            applications_template_repo.clone(branch=config.applications_template_repo_branch,force=True)
            applications_client_repo.clone()

        template_var_file = 'variable-template/terraform.tfvars'
        client_var_file = f'config/{config.environment}/{config.region}/terraform.tfvars'
        template_backend_config = 'backends/backend.tfvars'
        client_backend_config = f'config/{config.environment}/{config.region}/backend.tfvars'

        variables = {
            "terraform_ver": config.terraform_ver,
            "AWS_PROFILE": argvs.awsprofile,
            # "AWS_ACCESS_KEY_ID": "",
            # "AWS_SECRET_ACCESS_KEY": "",
            "AWS_DEFAULT_REGION": config.region,
            "var_file": client_var_file,
            "backend_config": client_backend_config
        }

        # Apply changes to template vars
        myLOGS.log("info", "Generate terraform variables based on template and config file...")
        myTERRAFORM.override_tfvars(myCONFIG.filename, os.path.join(template_repo.local_path, template_var_file), variables)
        myTERRAFORM.generate_backend_config(config,os.path.join(template_repo.local_path, template_backend_config), variables)

        client_repo_files_map = {
            template_var_file: client_var_file,
            template_backend_config: client_backend_config
        }

        myLOGS.log("info", "Bootstrap infrastructure-as-code git repository...")
        client_repo.bootstrap(template_repo, client_repo_files_map, argvs.update_infra)

        # In dry-run mode, if the state bucket wasn't created, inform the user and exit
        if not bucket_created and argvs.dry_run:
            myLOGS.log("critical", "State bucket does not exist. Dry-run mode will not create it.")
            myLOGS.log("critical", "To create the bucket only (to continue with the script), run with the --create-state-bucket-only flag.")
            exit(1)

        #RUN TERRAFORM
        myLOGS.log("info", "Create terraform plan ...")
        myTERRAFORM.plan(client_repo.local_path, variables, argvs.update_infra)

        # Run infracost only if the token is set
        myINFRACOST.run_infracost()

        #TODO: conditional run of TF autoaply when dry-run flag is not supplied
        if not argvs.dry_run:
            myLOGS.log("info", "Apply terraform. This can take a while... For more info check log file logs/terraform.apply.log")
            myTERRAFORM.apply(client_repo.local_path, variables)

        myLOGS.log("info", "Get terraform outputs...")
        outputs = myTERRAFORM.output(client_repo.local_path, variables)

        if not outputs and argvs.dry_run:
            myLOGS.log("normal", "No Terraform outputs found. This is expected in dry-run mode if 'terraform apply' was not yet run. Skipping kubeconfig generation...")
        else:
            clusterName = myTERRAFORM.output(client_repo.local_path, variables, "eks_cluster_name")
            myK8S.getContext(clusterName)


        # Save infra-facts.yaml
        myIDPSTATE.save_infra_facts(config, outputs, dry_run=argvs.dry_run)

        myLOGS.log("info", "Bootstraping git-ops repository with infrastructure services ...")
        argo_client_repo.bootstrap_argo(config, argo_template_repo, 'temp/infra-facts.yaml', argvs.update_gitops, argvs.update_infra_facts_only)

        # Bootstrap the app repository (if specified)
        if config.applications_template_repo:
            myLOGS.log("info", "Bootstraping git-ops repository with custom applications ...")
            applications_client_repo.bootstrap_app_repo(config, applications_template_repo, 'temp/infra-facts.yaml', argvs.update_gitops, argvs.update_infra_facts_only)

        if argvs.update_infra_facts_only:
            myLOGS.log("normal", "Exiting due to --update-infra-facts-only")
            script_success = True
            exit()

        # Install ArgoCD
        #TODO: Update logs location to no flood the main script
        myLOGS.log("info", "Install ArgoCD...")
        variables = {
            "AWS_PROFILE": argvs.awsprofile,
            # "AWS_ACCESS_KEY_ID": "",
            # "AWS_SECRET_ACCESS_KEY": "",
            "AWS_DEFAULT_REGION": config.region,
            "KUBECONFIG": "temp/kubeconfig"
        }
        myLOGS.log("normal", f'Installing or upgrading ArgoCD helm chart')
        argocd_helm_chart_values_files = [
            f"{argo_client_repo.local_path}/helm/argo-cd/values/{config.environment}/{config.region}/values.generated.yaml",
            f"{argo_client_repo.local_path}/helm/argo-cd/values/{config.environment}/{config.region}/values.yaml",
        ]

        argocd_repositories = [
            {
                "username": "argocd",
                "password": config.gitops_argo_access_token,
                "repoUrl": config.gitops_destination_repo
            }
        ]

        # Add the applications git repository credentials to argo, if specified
        if config.applications_template_repo:
            argocd_repositories.append(
                {
                    "username": "argocd",
                    "password": config.applications_argo_access_token,
                    "repoUrl": config.applications_destination_repo
                }
            )

        argocd_set_json = f"argocdRepositories={json.dumps(argocd_repositories)}"

        # Example: helm upgrade --install argocd git/client_argo_repo/helm/argo-cd/ -n argocd -f git/client_argo_repo/helm/argo-cd/values/stg/eu-west-1/values.yaml --set-json 'argocdRepositories=[{"username": "argocd", "password": "somepassword", "repoUrl": "https://gitlab.itgix.com/rnd/app-platform/demo-environments/demo-argocd-services-client"}]' > ./logs/helm.install.log
        myHelm.upgradeinstall("argocd", f"{argo_client_repo.local_path}/helm/argo-cd/", "argocd" , argocd_helm_chart_values_files, variables, set_json=argocd_set_json)

        argocd_ui_dns = f'{config.project_name}-{config.region}-argocd-{config.environment}.{config.dns_main_domain}'
        myLOGS.log("warning", f"Check ArgoCD for further progress of the deployments: https://{argocd_ui_dns}")

        myLOGS.log("normal", f'Apply manifests of main Argo custom resources - app of apps')
        myK8S.apply("argocd", "git/client_argo_repo/manifests/argocd/app-of-app.yaml",variables)
        argo_infrasvc_manifest_path = f'git/client_argo_repo/manifests/applications/infra-app-stages/{config.environment}/{config.region}/infra-services.yaml'
        myK8S.apply("argocd",argo_infrasvc_manifest_path,variables)

        if config.backstage_enabled:
            backstage_ui_dns = f'{config.project_name}-{config.region}-backstage-{config.environment}.{config.dns_main_domain}'
            myLOGS.log("warning", f"Backstage UI is available at: https://{backstage_ui_dns}")

        if config.applications_template_repo:
            myLOGS.log("normal", f'Apply manifests of main Applications custom resources - app of apps')
            myK8S.apply("argocd", "git/client_applications_repo/manifests/argocd/app-of-app.yaml",variables)
            applications_svc_manifest_path = f'git/client_applications_repo/manifests/applications/applications-app-stages/{config.environment}/{config.region}/applications.yaml'
            myK8S.apply("argocd",applications_svc_manifest_path,variables)

        script_success = True
    except Exception as error:
        myLOGS.log("critical", f'An exception occurred: {error}\n\n{traceback.format_exc()}')
        script_success = False
    finally:
        myCOLORS.loading = True
        time.sleep(0.2)
        if script_success:
            myLOGS.log("normal", "Script execution finished successfully")
        else:
            myLOGS.log("critical", "Script execution terminated due to errors.")
    #UPDATE SECRETS

idpInitMain()
