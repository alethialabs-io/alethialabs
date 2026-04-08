#!/bin/bash

# Exit on error
set -e

# unameOut="$(uname -s)"
# case "${unameOut}" in
#     Linux*)     machine=Linux;;
#     Darwin*)    machine=Mac;;
#     *)          machine="UNKNOWN"
# esac

# if [[ $machine == "Linux" ]]; then
# # for Linux
# ARCH=amd64
# OPSYS=linux
# fi
# if [[ $machine == "Mac" ]]; then
# # for MAC ARM
# ARCH=arm64
# OPSYS=darwin
# fi
# if [[ $machine == "UNKNOWN" ]]; then
#  echo "Your computer architecture is not supported, please setup manually using the docs"
#  exit 2
# fi
IDPVERSION=v1.0.1

export HOMEBREW_NO_AUTO_UPDATE=1

# install/upgrade bash

brew install bash

# Install AWS CLI

if [ ! -f /usr/local/bin/aws ] || [ -f /usr/local/aws-cli ]; then
 echo installing aws cli
 brew install awscli
else
 echo aws cli already installed
 aws --version
fi



if ! command -v kubectl &> /dev/null
then
  echo installing kubectl
  brew install kubernetes-cli
else
 echo kubectl already installed
 kubectl version --client || true
fi


if ! command -v helm &> /dev/null
then
  echo installing helm
  brew install helm
else 
  echo helm already installed make sure its at least version 3.17
  helm version
fi

if ! command -v yq &> /dev/null
then 
  echo installing yq
  brew install yq
else
  echo "yq is already installed"
  yq -V
fi


if ! command -v terraform &> /dev/null
then
  echo installing terraform
  brew install terraform
else
  echo "terraform is already installed"
  terraform version
fi


if [ -d ./venv ];
then
  echo "IDP installer directory already present. Assuming python environment is set"
else
  python3 -m venv venv
  source ./venv/bin/activate
  pip3 install --upgrade pip
  pip3 install -r requirements.txt
  deactivate
  mkdir temp; mkdir git
fi
