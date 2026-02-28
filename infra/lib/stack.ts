import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as amplify from "@aws-cdk/aws-amplify-alpha";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export class ExclusiveResortsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── VPC ────────────────────────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "Private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    // ─── RDS Security Group ──────────────────────────────────────────────────
    const dbSG = new ec2.SecurityGroup(this, "DbSecurityGroup", {
      vpc,
      description: "Allow PostgreSQL access",
    });
    dbSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5432), "Postgres from Amplify Lambda");

    // ─── RDS PostgreSQL ──────────────────────────────────────────────────────
    const dbInstance = new rds.DatabaseInstance(this, "Database", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_15,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [dbSG],
      publiclyAccessible: true,
      databaseName: "exclusive_resorts",
      credentials: rds.Credentials.fromGeneratedSecret("postgres"),
      backupRetention: cdk.Duration.days(7),
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ─── Cognito User Pool ───────────────────────────────────────────────────
    const userPool = new cognito.UserPool(this, "ConciergeUserPool", {
      userPoolName: "exclusive-resorts-concierge",
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolClient = new cognito.UserPoolClient(this, "ConciergeUserPoolClient", {
      userPool,
      userPoolClientName: "exclusive-resorts-web",
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false,
    });

    // ─── GitHub Token (store in Secrets Manager before deploying) ───────────
    const githubToken = cdk.SecretValue.secretsManager("exclusive-resorts/github-token");

    // ─── Amplify Hosting ─────────────────────────────────────────────────────
    const amplifyApp = new amplify.App(this, "AmplifyApp", {
      appName: "exclusive-resorts",
      platform: amplify.Platform.WEB_COMPUTE,
      sourceCodeProvider: new amplify.GitHubSourceCodeProvider({
        owner: "vishalp23",
        repository: "exclusive-resorts-deploy",
        oauthToken: githubToken,
      }),
      buildSpec: cdk.aws_codebuild.BuildSpec.fromObjectToYaml({
        version: "1.0",
        frontend: {
          phases: {
            preBuild: { commands: ["npm ci"] },
            build: { commands: ["npm run build"] },
          },
          artifacts: {
            baseDirectory: ".next",
            files: ["**/*"],
          },
          cache: { paths: ["node_modules/**/*", ".next/cache/**/*"] },
        },
      }),
      environmentVariables: {
        NEXT_PUBLIC_COGNITO_USER_POOL_ID: userPool.userPoolId,
        NEXT_PUBLIC_COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        NEXT_PUBLIC_AWS_REGION: this.region,
      },
    });

    const mainBranch = amplifyApp.addBranch("main", {
      autoBuild: true,
      stage: "PRODUCTION",
    });

    // ─── Pass DATABASE_URL to Amplify after RDS is ready ────────────────────
    const dbSecret = dbInstance.secret!;
    amplifyApp.addEnvironment(
      "DATABASE_URL",
      `postgresql://postgres:${dbSecret.secretValueFromJson("password").unsafeUnwrap()}@${dbInstance.dbInstanceEndpointAddress}:5432/exclusive_resorts`
    );

    // ─── CloudFormation Outputs ──────────────────────────────────────────────
    new cdk.CfnOutput(this, "AmplifyAppUrl", {
      value: `https://${mainBranch.branchName}.${amplifyApp.defaultDomain}`,
      description: "Amplify app URL",
    });

    new cdk.CfnOutput(this, "CognitoUserPoolId", {
      value: userPool.userPoolId,
      description: "Cognito User Pool ID — set as NEXT_PUBLIC_COGNITO_USER_POOL_ID",
    });

    new cdk.CfnOutput(this, "CognitoClientId", {
      value: userPoolClient.userPoolClientId,
      description: "Cognito App Client ID — set as NEXT_PUBLIC_COGNITO_CLIENT_ID",
    });

    new cdk.CfnOutput(this, "RdsEndpoint", {
      value: dbInstance.dbInstanceEndpointAddress,
      description: "RDS endpoint — use to build DATABASE_URL",
    });

    new cdk.CfnOutput(this, "DbSecretArn", {
      value: dbInstance.secret!.secretArn,
      description: "Secrets Manager ARN for RDS credentials",
    });
  }
}
