#!/usr/bin/env bash
set -e
GREEN="32"
BOLDGREEN="\e[1;${GREEN}m"
ENDCOLOR="\e[0m"

OPTSTRING=":f:adchke"
cli_tools=('kubectl' 'yq' 'git' 'terraform' 'aws')
conf_file=""
tf_destroy=0
auto_destroy=0
tf_action=0
auto_cleanup=0
full_cleanup=0
cleanup_specfic_env=0
environment=''
region=''
proj=''
tf_destroy_command=''
tf_repo='git/client_repo'
argo_repo='git/client_argo_repo'
argo_repo_apps='git/client_applications_repo'
kubectl_timeout=600
kconfig=''
skip_k8s=0

argocd_ns='argocd'
app_of_apps=()

cleanup() {
  # Put here actions we want to run before script exits
  if [ -f $kconfig ]; then
      rm -f $kconfig
  fi
}

trap cleanup EXIT

declare -A aws_regions_short=( ['ap-east-1']='ae1' ['ap-northeast-1']='an1' ['ap-northeasa-t2']='an2'
  ['ap-northeast-3']='an3' ['ap-south-1']='as0' ['ap-southeast-1']='as1' ['ap-southeast-2']='as2'
  ['ca-central-1']='cc1' ['eu-central-1']='ec1' ['eu-north-1']='en1' ['eu-south-1']='es1'
  ['eu-west-1']='ew1' ['eu-west-2']='ew2' ['eu-west-3']='ew3' ['af-south-1']='fs1'
  ['me-south-1']='ms1' ['sa-east-1']='se1' ['us-east-1']='ue1' ['us-east-2']='ue2'
  ['us-west-1']='uw1' ['us-west-2']='uw2' )

printHelp() {
  echo -e "
    ${BOLDGREEN}Must be run from idp-installer directory. Cleanup script for tearing down container platforms.
    CLI tools required: ${cli_tools[@]}

    -f (required): pass idp-installer configuration yaml
    -a (optional): run terraform destroy with auto-approve
    -d (optional): run terraform destroy with interactive approval
    -c (optional): cleanup repositories
    -e (optional): cleanup environment-specific files only in repositoris
    -k (optional): skip k8s cluster cleanup with kubectl
    ${ENDCOLOR}
    "
}

function cleanRepo() {
  local repo_path=$1
  if [ $auto_cleanup -eq 1 ]; then
    if [ $full_cleanup -eq 1 ] && [ $cleanup_specfic_env -eq 1 ]; then
      echo "-c and -e are mutually exclusive"
      exit 1
    elif [ $full_cleanup -eq 1 ]; then
      if [ -d $repo_path ] && [ -n "$(ls -A -I .git $repo_path)" ]; then
        echo -e "Wipe clean client repo $repo_path"
        pushd $repo_path
        git pull
        git rm -r ./*
        git commit -m 'Cleaning up client repo'
        git push
        popd
      fi
    elif [ $cleanup_specfic_env -eq 1 ]; then
      if [ -d $repo_path ]; then
        pushd $repo_path
        case $repo_path in
          'git/client_repo')
            git pull
            if [ -d config/${environment}/${region} ]; then
              git rm -r config/${environment}/${region}
            fi
            if ! [ -z "$(git status -s)" ]; then
              git commit -m 'Cleaning up specifc environment from client repo'
              git push
            fi
            ;;
          'git/client_argo_repo')
            git pull
            if [ -d helm/infra-services/values/${environment}/${region} ]; then
              git rm -r helm/infra-services/values/${environment}/${region}
            fi
            if [ -d manifests/applications/infra-app-stages/${environment}/${region} ]; then
              git rm -r manifests/applications/infra-app-stages/${environment}/${region}
            fi
            if ! [ -z "$(git status -s)" ]; then
              git commit -m 'Cleaning up specifc environment from client repo'
              git push
            fi
            ;;
          'git/client_applications_repo')
            git pull
            if [ -d helm/applications/values/${environment}/${region} ]; then
              git rm -r helm/applications/values/${environment}/${region}
            fi
            if [ -d manifests/applications/applications-app-stages/${environment}/${region} ]; then
              git rm -r manifests/applications/applications-app-stages/${environment}/${region}
            fi
            if ! [ -z "$(git status -s)" ]; then
              git commit -m 'Cleaning up specifc environment from client repo'
              git push
            fi
            ;;
        esac
        popd
      fi
    fi
  fi
}


while getopts $OPTSTRING opt; do
  case $opt in
  f)
    conf_file=$OPTARG
    ;;
  a)
    auto_destroy=1
    tf_action=1
    ;;
  d)
    tf_destroy=1
    tf_action=1
    ;;
  c)
    full_cleanup=1
    auto_cleanup=1
    ;;
  e)
    cleanup_specfic_env=1
    auto_cleanup=1
    ;;
  k)
    skip_k8s=1
    ;;
  h)
    printHelp
    exit 0
    ;;
  ?)
    echo -e "${BOLDGREEN}Invalid option: -$OPTARG.${ENDCOLOR}"
    printHelp
    exit 1
    ;;
  esac
done

for tool in ${cli_tools[@]}; do
  type $tool >/dev/null 2>&1 || {
    echo >&2 -e "${BOLDGREEN}I require $tool but it's not installed.${ENDCOLOR}"
    printHelp
    exit 1
  }
done

if [ $(basename $PWD) != 'idp-installer' ] || [ -z $conf_file ]; then
  printHelp
  exit 1
fi

environment=$(yq -r .environment $conf_file)
region=$(yq -r .region $conf_file)
proj=$(yq -r .project_name $conf_file)
tf_destroy_command="terraform destroy -var-file=config/$environment/$region/terraform.tfvars"

if ! [ -f $tf_repo/config/$environment/$region/terraform.tfvars ]; then
  echo -e "${BOLDGREEN}Invalid idp variable file. Terraform tfvars not found.${ENDCOLOR}"
fi

if [ $tf_action -eq 1 ]; then
  echo -e "${BOLDGREEN}Check for AWS account access..${ENDCOLOR}"
  aws sts get-caller-identity >/dev/null 2>&1 || {
    echo >&2 -e "${BOLDGREEN}AWS account access not configured.${ENDCOLOR}"
    exit 1
  }
fi

if [ $skip_k8s -eq 0 ]; then
  echo -e "${BOLDGREEN}Configure kubectl..${ENDCOLOR}"
  kconfig=$(mktemp -p $PWD/temp)
  echo aws eks update-kubeconfig --region ${region} --name eks-${aws_regions_short[$region]}-${environment}-${proj} --kubeconfig $kconfig
  aws eks update-kubeconfig --region ${region} \
    --name eks-${aws_regions_short[$region]}-${environment}-${proj} \
    --kubeconfig $kconfig
  export KUBECONFIG=$kconfig

  kubectl cluster-info >/dev/null 2>&1 || {
    echo >&2 -e "${BOLDGREEN}Failed to configure kubernetes cluster access.${ENDCOLOR}"
    exit 1
    }
fi


getSelfHeal() {
  local app=$1
  local ns=$2
  heal_value=$(kubectl get app $app -n $ns -o jsonpath='{.spec.syncPolicy.automated.selfHeal}')
  if [ -z $heal_value ]; then
    heal_value='false'
  fi
  printf $heal_value
}

if [ $skip_k8s -eq 0 ]; then
  echo -e "${BOLDGREEN}Make a list of app-of-app applications${ENDCOLOR}"
  for app in $(kubectl get app -n $argocd_ns -o jsonpath='{.items[*].metadata.name}'); do
    kubectl get app $app -n $argocd_ns -o yaml \
      | yq .status.resources[].kind \
      | grep -q Application \
      && app_of_apps+=("$app")
  done
  printf '%s\n' "${app_of_apps[@]}"

  echo -e "${BOLDGREEN}Disable autosync and self-healing on all argocd applications, starting with app of apps${ENDCOLOR}"

  for aoa in "${app_of_apps[@]}"; do
    if [ "$(getSelfHeal $aoa $argocd_ns)" == "true" ]; then
      kubectl patch app $aoa --type='json' \
        -p='[{"op": "replace", "path": "/spec/syncPolicy", "value": null}]' \
        -n $argocd_ns
    fi
  done

  for app in $(kubectl get app -n $argocd_ns -o jsonpath='{.items[*].metadata.name}'); do
    if [ "$(getSelfHeal $app $argocd_ns)" == "true" ]; then
      kubectl patch app $app --type='json' \
        -p='[{"op": "replace", "path": "/spec/syncPolicy", "value": null}]' \
        -n $argocd_ns
    fi
  done

  echo -e "${BOLDGREEN}Ingress resources for removal (all namespaces):${ENDCOLOR}"

  kubectl get ing -A -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}'

  echo -e "${BOLDGREEN}Delete all ingress resources. WAIT for finalizers${ENDCOLOR}"
  echo -e "${BOLDGREEN}kubectl timeout set to ${kubectl_timeout} seconds${ENDCOLOR}"

  kubectl delete ing --all --all-namespaces --wait=true --timeout=${kubectl_timeout}s

fi

if [ $tf_action -eq 1 ]; then
  echo -e "${BOLDGREEN}Tear down all AWS resources${ENDCOLOR}"

  pushd $tf_repo
  terraform init -backend-config=config/$environment/$region/backend.tfvars -reconfigure

  if [ $auto_destroy -eq 1 ]; then
    $tf_destroy_command -auto-approve
  else
    $tf_destroy_command
  fi
  popd

  cleanRepo $tf_repo

fi

cleanRepo $argo_repo
cleanRepo $argo_repo_apps


exit 0
