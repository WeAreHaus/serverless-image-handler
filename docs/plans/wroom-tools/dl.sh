#!/bin/zsh
export AWS_PROFILE=wroom
h=$1; D=$2
aws s3api list-objects-v2 --bucket serverless-image-handler-logs-07b19942 --prefix "wrooom.webien.io/E3K100LLRITAXV.$h" --query 'Contents[].Key' --output text | tr '\t' '\n' | grep -v '^None$' | while read k; do
  [ -f "$D/${k##*/}" ] || aws s3 cp --quiet "s3://serverless-image-handler-logs-07b19942/$k" "$D/${k##*/}"
done
