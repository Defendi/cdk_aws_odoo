import * as cdk from 'aws-cdk-lib';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Duration, Stack, StackProps } from "aws-cdk-lib";
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as albv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

export class ErpStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const dbport = 5432;
    const serviceName = this.stackName;
    const dbusername = "opususer";
    const dbname = "opusdb";
    const stage = "dev";
    const VOLUME_NAME = `${serviceName}-data-vol-${stage}`

    const allAll = ec2.Port.allTraffic();
    const tcpOpusDb = ec2.Port.tcpRange(dbport, dbport);
    const tcpOpusWebErp = ec2.Port.tcp(8069)
    const tcpOpusLPErp = ec2.Port.tcp(8072)

    var ingressSources = [ec2.Peer.ipv4('0.0.0.0/0')];

    // 👇 vpc
    const vpc = new ec2.Vpc(this, `${serviceName}-vpc-${stage}`, {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "OpusPublicSubnet",
          subnetType: ec2.SubnetType.PUBLIC
        },
        {
          cidrMask: 24,
          name: "OpusPrivateSubnet",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
        }
      ]
    });

    // 👇 credentials for Opus DB
    const opusDBSecret = new secretsmanager.Secret(this, `${serviceName}-credentials-${stage}`, {
      secretName: `${serviceName}-credentials-${stage}`,
      description: 'Postgresql Database Crendetials',
      generateSecretString: {
        excludeCharacters: "\"@/\\ |'",
        generateStringKey: 'password',
        passwordLength: 30,
        secretStringTemplate: JSON.stringify({ username: dbusername }),
      },
    })

    const OpusCredentials = rds.Credentials.fromSecret(
      opusDBSecret,
      dbusername,
    );

    // 👇 Database Security Group
    const dbsg = new ec2.SecurityGroup(this, `${serviceName}-db-securitygroup-${stage}`, {
      vpc: vpc,
      allowAllOutbound: false,
      description: id + `${serviceName}-db-securitygroup-${stage}`,
      securityGroupName: id + `${serviceName}-db-securitygroup-${stage}`,
    });

    //dbsg.addIngressRule(dbsg, allAll, `all in DB ${stage}`);
    dbsg.addEgressRule(ec2.Peer.ipv4('0.0.0.0/0'), tcpOpusDb, `tcp5432 Postgres ${stage}`);

    // const opusConnectionPorts = [
    //   { port: tcpOpusDb, description: 'tcp5432 Postgres '+stage },
    // ];

    // for (let ingressSource of ingressSources!) {
    //   for (let c of opusConnectionPorts) {
    //     dbsg.addIngressRule(ingressSource, c.port, c.description);
    //   }
    // }

    // 👇 create RDS instance
    const dbInstance = new rds.DatabaseInstance(this, `${serviceName}-db-instance-${stage}`, {
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_14_7,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE3,
        ec2.InstanceSize.MICRO,
      ),
      credentials: OpusCredentials,
      securityGroups: [dbsg],
      multiAz: false,
      allocatedStorage: 10,
      maxAllocatedStorage: 11,
      allowMajorVersionUpgrade: false,
      autoMinorVersionUpgrade: true,
      backupRetention: cdk.Duration.days(0),
      deleteAutomatedBackups: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
      publiclyAccessible: true,
    });

    // 👇 Inicio do ECS

    const clusteradmin = new iam.Role(this, `${serviceName}-admin-role-${stage}`, {
      assumedBy: new iam.AccountRootPrincipal()
    });

    const taskrole = new iam.Role(this, `${serviceName}-ecs-taskrole-${stage}`, {
      roleName: `ecs-taskrole-${stage}`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    });

    const executionRolePolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ['*'],
      actions: [
        "ecr:getauthorizationtoken",
        "ecr:batchchecklayeravailability",
        "ecr:getdownloadurlforlayer",
        "ecr:batchgetimage",
        "logs:createlogstream",
        "logs:putlogevents"
      ]
    });

    // 👇 ECS Security Group
    const erpsg = new ec2.SecurityGroup(this, `${serviceName}-erp-securitygroup-${stage}`, {
      vpc: vpc,
      allowAllOutbound: true,
      description: id + `${serviceName}-erp-securitygroup-${stage}`,
      securityGroupName: id + `${serviceName}-erp-securitygroup-${stage}`,
    });

    // 👇 Load Balancer

    const albsg = new ec2.SecurityGroup(this, `${serviceName}-lb-securitygroup-${stage}`, {
      vpc: vpc,
      allowAllOutbound: true,
      description: id + `${serviceName}-lb-securitygroup-${stage}`,
      securityGroupName: id + `${serviceName}-lb-securitygroup-${stage}`,
    });

    albsg.addIngressRule(ec2.Peer.anyIpv4(), tcpOpusWebErp)
    albsg.addIngressRule(ec2.Peer.anyIpv4(), tcpOpusLPErp)

    //erpsg.addIngressRule(erpsg, allAll, `all in ERP ${stage}`);
    erpsg.addIngressRule(ec2.Peer.securityGroupId(albsg.securityGroupId), tcpOpusWebErp, `tcp Opus web Erp ${stage}`);
    erpsg.addIngressRule(ec2.Peer.securityGroupId(albsg.securityGroupId), tcpOpusLPErp, `tcp Opus LP Erp ${stage}`);
    //erpsg.addEgressRule(ec2.Peer.ipv4('0.0.0.0/0'), allAll, `all out tcp Opus Erp`);


    const loadBalancer = new albv2.ApplicationLoadBalancer(this, `${serviceName}-alb-${stage}`, {
      vpc: vpc,
      loadBalancerName: `alb-${serviceName}-${stage}`,
      internetFacing: true,
      idleTimeout: Duration.minutes(10),
      securityGroup: albsg,
      http2Enabled: false,
      deletionProtection: false,
    });

    const httpListener = loadBalancer.addListener(`${serviceName}-http-listner-${stage}`, {
      port: 8069,
      open: true,
      protocol: albv2.ApplicationProtocol.HTTP
    })

    const targetGroup = httpListener.addTargets(`${serviceName}-tcp-listener-target-${stage}`, {
      targetGroupName: "tcp-target-ecs-service",
      protocol: albv2.ApplicationProtocol.HTTP,
      protocolVersion: albv2.ApplicationProtocolVersion.HTTP1,
    })

    const cluster = new ecs.Cluster(this, `${serviceName}-cluster-${stage}`, { vpc });

    const taskDef = new ecs.FargateTaskDefinition(this, `${serviceName}-task-definition-${stage}`, {
      cpu: 1024,
      memoryLimitMiB: 2048,
      taskRole: taskrole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    taskDef.addToExecutionRolePolicy(executionRolePolicy);

    const logging = new ecs.AwsLogDriver({
      streamPrefix: "erp-logs"
    });

    const container = taskDef.addContainer(`${serviceName}-container-${stage}`, {
      image: ecs.ContainerImage.fromRegistry("672847879444.dkr.ecr.us-east-1.amazonaws.com/opuserp15:latest"),
      logging,
      environment: {
        POSTGRES_HOST: dbInstance.dbInstanceEndpointAddress,
        POSTGRES_PORT: dbInstance.dbInstanceEndpointPort,
        POSTGRES_USER: opusDBSecret.secretValueFromJson('username').unsafeUnwrap().toString(),
        POSTGRES_PASSWORD: opusDBSecret.secretValueFromJson('password').unsafeUnwrap().toString(),
      },
    });

    container.addPortMappings({ containerPort: 8069, protocol: ecs.Protocol.TCP });
    container.addPortMappings({ containerPort: 8072, protocol: ecs.Protocol.TCP });

    // Instantiate ECS Service with just cluster and image
    const ecsService = new ecs.FargateService(this, `${serviceName}-fargate-service-${stage}`, {
      cluster,
      taskDefinition: taskDef,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC, },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      assignPublicIp: false,
      enableExecuteCommand: true,
      securityGroups: [erpsg],
      desiredCount: 1,
    });

    dbInstance.connections.allowFrom(ecsService, ec2.Port.tcp(5432));

    new cdk.CfnOutput(this, 'dbEndpoint', {
      value: dbInstance.instanceEndpoint.hostname,
    });

    new cdk.CfnOutput(this, 'secretName', {
      // eslint-disable-next-line @typescript-eslint/no-non-null-asserted-optional-chain
      value: dbInstance.secret?.secretName!,
    });
  }
}
