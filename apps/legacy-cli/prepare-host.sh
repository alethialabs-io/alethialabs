#!/bin/bash

# Exit on error
set -e

unameOut="$(uname -s)"
case "${unameOut}" in
    Linux*)     machine=Linux;;
    Darwin*)    machine=Mac;;
    *)          machine="UNKNOWN"
esac

if [[ $machine == "Linux" ]]; then
# for Linux
ARCH=amd64
OPSYS=linux
fi
if [[ $machine == "Mac" ]]; then
# for MAC ARM
ARCH=arm64
OPSYS=darwin
fi
if [[ $machine == "UNKNOWN" ]]; then
 echo "Your computer architecture is not supported, please setup manually using the docs"
 exit 2
fi
IDPVERSION=v1.0.1

# Install AWS CLI

if [ ! -f /usr/local/bin/aws ]; then
 echo installing aws cli
 cd /tmp
 curl "https://s3.amazonaws.com/aws-cli/awscli-bundle.zip" -o "awscli-bundle.zip"
 unzip awscli-bundle.zip
 ./awscli-bundle/install -i /usr/local/aws -b /usr/local/bin/aws
 cd -
else
 echo aws cli already installed
 aws --version
fi



if ! command -v kubectl &> /dev/null
then
  echo installing kubectl
  cd /tmp/
  curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/${OPSYS}/${ARCH}/kubectl"
  mv kubectl /usr/local/bin/kubectl
  chmod 755 /usr/local/bin/kubectl
  cd -
else
 echo kubectl already installed
 kubectl version --client || true
fi


if ! command -v helm &> /dev/null
then
  echo installing helm
  cd /tmp/
  curl -fsSL -o get_helm.sh https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3
  chmod 700 get_helm.sh
  ./get_helm.sh
  cd -
else 
  echo helm already installed make sure its at least version 3.17
  helm version
fi

if ! command -v yq &> /dev/null
then 
  echo installing yq
  if [[ "$OPSYS" == "darwin" ]]; then
    brew install yq@3
  else
    snap install yq
  fi
else
  echo "yq is already installed"
  yq -V
fi

if [ -d ./venv ];
then
  echo "IDP installer directory already present. Assuming python environment is set"
else
  echo "Preparing IDP python virtual environment"
  python3 -m venv venv
  source ./venv/bin/activate
  pip3 install --upgrade pip
  pip3 install -r requirements.txt
  deactivate
  mkdir temp; mkdir git
fi

