// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { App, DefaultStackSynthesizer } from "aws-cdk-lib";
import { ServerlessImageHandlerStack } from "../lib/serverless-image-stack";
import { ManagementStack, ManagementStackProps } from "../lib/v8/stacks";

// Solutions pipeline deployment
const { DIST_OUTPUT_BUCKET, SOLUTION_NAME, VERSION, SOLUTION_ID } = process.env;
const { PUBLIC_ECR_REGISTRY } = process.env;

// Haus (Wroom): one synthesizer per stack. A shared instance merges both stacks' assets into one manifest, so
// deploying only v7-Stack also tried to publish the v8 container image.
const createSynthesizer = () =>
  DIST_OUTPUT_BUCKET && SOLUTION_NAME && VERSION
    ? new DefaultStackSynthesizer({
        generateBootstrapVersionRule: false,
        fileAssetsBucketName: `${DIST_OUTPUT_BUCKET}-\${AWS::Region}`,
        bucketPrefix: `${SOLUTION_NAME}/${VERSION}/`,
      })
    : new DefaultStackSynthesizer({
        generateBootstrapVersionRule: false,
      });

const app = new App({
  context: {
    productionImageUri: PUBLIC_ECR_REGISTRY ? `${PUBLIC_ECR_REGISTRY}/${SOLUTION_NAME}:${VERSION}` : undefined,
  },
});

const solutionDisplayName = "Dynamic Image Transformation for Amazon CloudFront";
const solutionVersion = VERSION ?? app.node.tryGetContext("solutionVersion");
const solutionName = SOLUTION_NAME ?? app.node.tryGetContext("solutionName");
const solutionId = SOLUTION_ID ?? app.node.tryGetContext("solutionId");
const description = `(${solutionId}) - ${solutionDisplayName}. Version ${solutionVersion}`;

new ServerlessImageHandlerStack(app, "v7-Stack", {
  // Haus (Wroom): deploy under a chosen CloudFormation name, e.g. STACK_NAME=wroom-v8.
  stackName: process.env.STACK_NAME,
  synthesizer: createSynthesizer(),
  description,
  solutionId,
  solutionVersion,
  solutionName,
});

const managementStackProps: ManagementStackProps = {
  synthesizer: createSynthesizer(),
  solutionId,
  solutionName,
  solutionVersion,
  description,
};
new ManagementStack(app, "v8-Stack", managementStackProps);
