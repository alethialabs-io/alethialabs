FROM debian:bookworm-slim

RUN apt-get update && apt-get upgrade -y && \
    apt-get install -y curl unzip telnet jq yq tar gnupg git python3 python3-pip python3.11-venv && \
    curl -LO "https://storage.googleapis.com/kubernetes-release/release/$(curl -s https://storage.googleapis.com/kubernetes-release/release/stable.txt)/bin/linux/amd64/kubectl" && \
    chmod +x kubectl && \
    mv kubectl /usr/bin/ && \
    curl -LO "https://get.helm.sh/helm-v3.11.1-linux-amd64.tar.gz" && \
    tar -zxvf helm-v3.11.1-linux-amd64.tar.gz && \
    mv linux-amd64/helm /usr/bin/ && \
    rm -rf linux-amd64 && \
    rm helm-v3.11.1-linux-amd64.tar.gz && \
    curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" && \
    unzip awscliv2.zip && \
    ./aws/install && \
    rm -rf awscliv2.zip aws && \
    curl -LO https://amazon-eks.s3.us-west-2.amazonaws.com/1.17.9/2020-08-04/bin/linux/amd64/aws-iam-authenticator && \
    curl -o terraform_1.7.5_linux_amd64.zip -LO https://releases.hashicorp.com/terraform/1.7.5/terraform_1.7.5_linux_amd64.zip && \
    unzip terraform_1.7.5_linux_amd64.zip && \
    chmod +x terraform && \
    mv terraform /bin/terraform && \
    chmod +x aws-iam-authenticator && \
    mv aws-iam-authenticator /usr/bin/ && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /root

RUN mkdir adp-client
ADD ./bin ./config ./modules ./requirements.txt adp-client/
COPY idpinstall.py adp-client/idpinstall.py

RUN rm -rf adp-client/config/* 

RUN rm /bin/sh && ln -s /bin/bash /bin/sh
RUN cd adp-client/ && \
    python3 -m venv venv && \
    source ./venv/bin/activate && \
    pip3 install --upgrade pip && \
    pip3 install -r requirements.txt && \
    deactivate

RUN mkdir /root/.aws && chmod -R 777 /root
RUN mkdir /root/.ssh && touch /root/.ssh/known_hosts

