#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ErpStack } from '../lib/erp_stack-stack';

const app = new cdk.App();

const env: cdk.Environment = {
  account: "672847879444",
  region: "us-east-1"
}

const tags = {
  creator: "Via CDK",
  cost: "OpusERP",
  owner: "Alexandre Defendi"
}

const erpStack = new ErpStack(app, 'ErpOpus', {
  tags: tags,
  env: env,
})