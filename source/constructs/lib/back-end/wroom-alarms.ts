// Haus (Wroom): alarms on the image handler Lambda. No alarm actions yet; the target (email or Slack) is
// decided separately (docs/plans/wroom-improvements.md, phase 1 task 6). CloudFront 5xxErrorRate lives in
// us-east-1 only and cannot be alarmed from this regional stack.

import { Duration } from "aws-cdk-lib";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { IFunction } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

export interface WroomAlarmsProps {
  readonly imageHandlerLambdaFunction: IFunction;
}

export class WroomAlarms extends Construct {
  constructor(scope: Construct, id: string, props: WroomAlarmsProps) {
    super(scope, id);
    const fn = props.imageHandlerLambdaFunction;

    new Alarm(this, "LambdaErrors", {
      alarmDescription: "Wroom image handler: Lambda errors (crashes, not 4xx/5xx responses).",
      metric: fn.metricErrors({ period: Duration.minutes(5) }),
      threshold: 10,
      evaluationPeriods: 3,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    new Alarm(this, "LambdaThrottles", {
      alarmDescription: "Wroom image handler: Lambda throttles.",
      metric: fn.metricThrottles({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    new Alarm(this, "LambdaDurationP99", {
      alarmDescription: "Wroom image handler: p99 duration above 5 s for 15 minutes.",
      metric: fn.metricDuration({ period: Duration.minutes(5), statistic: "p99" }),
      threshold: 5000,
      evaluationPeriods: 3,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
  }
}
