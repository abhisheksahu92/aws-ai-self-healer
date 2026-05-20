# AWS AI Self-Healing Backend Pipeline

An autonomous AI-powered remediation pipeline for Node.js/TypeScript backends on AWS. When Sentry or a monitoring digest detects an issue, the pipeline automatically investigates the root cause, generates a code fix, runs tests, and opens a GitHub PR — with **zero human intervention until the PR review**.

> **Human role: review and merge the PR only.**

---

## How It Works

```
Sentry webhook ──┐
                 ├──► SNS ──► SQS ──► EventBridge Pipe ──► Step Functions
Monitoring digest┘
                           │
                           ▼
    INGEST → INVESTIGATE → FIX → TEST → PR → NOTIFY
    (Lambda)  (Fargate)  (Fargate)(Fargate)(Lambda)(Lambda)
                           │
                    S3 state bus
```

### The 6 Stages

| Stage | Runtime | What it does |
|-------|---------|-------------|
| **INGEST** | Lambda | Receives Sentry webhook, rate-limits (3/hour/service), enriches with CloudWatch logs |
| **INVESTIGATE** | Fargate | Clones repo, reads implicated files, calls Bedrock Claude for root cause + confidence score (0–100) |
| **FIX** | Fargate | If confidence ≥ 60: generates unified diff via Bedrock, applies patch, pushes `healer/` branch |
| **TEST** | Fargate | Checks out healer branch, runs type-check + unit tests + ESLint on changed files |
| **PR** | Lambda | Opens GitHub PR with full investigation report, confidence score, test results, and `healer` label |
| **NOTIFY** | Lambda | Posts to Slack with PR link and summary |

Any stage failure routes to **PR + NOTIFY** with whatever investigation context was gathered — it never fails silently.

---

## Architecture Decisions

- **S3 as inter-stage state bus** — ECS `runTask.sync` doesn't capture stdout. Each Fargate stage reads/writes `pipeline-state/{executionId}/state.json` to pass data forward.
- **EventBridge Pipe (SNS → SQS → Step Functions)** — SNS can't be a Pipe source directly; SQS bridges it.
- **Bedrock (AWS-native)** — No external API keys. Claude Sonnet runs inside your AWS account via cross-region inference profiles.
- **Rate limiting** — DynamoDB atomic `UpdateCommand` with conditional expression prevents concurrent flood events from bypassing the 3/hour limit.
- **Scoped IAM** — 5 separate roles (Lambda, Task, TaskExecution, StateMachine, Pipe). `ecs:RunTask` scoped to `healer-*` task family ARNs only.
- **Security** — HMAC-SHA256 Sentry webhook validation, prompt injection defenses (`sanitizeForPrompt`), server-side file path allowlist (blocks diffs to `infrastructure/`, `.github/`, migrations, YAML, shell scripts).

---

## Prerequisites

- AWS account with Bedrock enabled in your region
- GitHub Personal Access Token (fine-grained, `Contents: write` + `Pull requests: write`)
- Sentry account (optional — can also trigger manually via Step Functions)
- Slack incoming webhook or AWS Chatbot configured for a channel
- Docker + AWS CLI + Node.js 20+

---

## Quick Start

### 1. Clone & install

```bash
git clone https://github.com/abhisheksahu92/aws-ai-self-healer
cd aws-ai-self-healer/infrastructure/healer
npm install
```

### 2. Run tests

```bash
npm test          # 25 tests, 7 suites
npm run type-check
```

### 3. Build Lambda bundles + Fargate tasks

```bash
npm run build         # Lambda bundles → dist/lambdas/
npm run build:tasks   # Fargate task bundles → dist/tasks/
```

### 4. Create ECR repository

```bash
aws ecr create-repository --repository-name your-project/healer --region your-region
```

### 5. Build & push Docker image

```bash
ECR_URI=YOUR_ACCOUNT.dkr.ecr.YOUR_REGION.amazonaws.com/your-project/healer
aws ecr get-login-password --region YOUR_REGION | docker login --username AWS --password-stdin YOUR_ACCOUNT.dkr.ecr.YOUR_REGION.amazonaws.com
docker build -t $ECR_URI:latest .
docker push $ECR_URI:latest
```

### 6. Package Lambda zips

```bash
cd dist/lambdas
for f in ingest stage-ingest stage-pr stage-notify; do
  python3 -c "
import zipfile
with zipfile.ZipFile('$f.zip','w') as z:
    z.write('$f/index.js','index.js')
"
done
aws s3 cp . s3://YOUR-BUCKET/healer/lambdas/ --recursive --exclude "*" --include "*.zip"
```

### 7. Store secrets in AWS Secrets Manager

```bash
# GitHub PAT (Contents: write + Pull requests: write)
aws secretsmanager create-secret \
  --name "/your-project/healer/github-token" \
  --secret-string "ghp_YOUR_GITHUB_TOKEN"

# Sentry webhook HMAC secret (from Sentry → Settings → Integrations → Webhooks)
aws secretsmanager create-secret \
  --name "/your-project/healer/sentry-webhook-secret" \
  --secret-string "YOUR_SENTRY_HMAC_SECRET"
```

### 8. Deploy CloudFormation stack

```bash
aws cloudformation deploy \
  --template-file infrastructure/cloudformation/self-healing-pipeline.yaml \
  --stack-name your-project-self-healing-pipeline \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    Environment=dev \
    ProjectName=your-project \
    EcsClusterArn="arn:aws:ecs:REGION:ACCOUNT:cluster/your-cluster" \
    SubnetId="subnet-XXXXXXXX" \
    SecurityGroupId="sg-XXXXXXXX" \
    GithubTokenSecretArn="arn:aws:secretsmanager:REGION:ACCOUNT:secret:/your-project/healer/github-token" \
    GithubRepoOwner="your-github-org" \
    GithubRepoName="your-repo" \
    SlackWebhookUrl="https://hooks.slack.com/services/..." \
    HealerImageUri="ACCOUNT.dkr.ecr.REGION.amazonaws.com/your-project/healer:latest" \
    BedrockModelId="us.anthropic.claude-sonnet-4-6"
```

### 9. Wire Sentry webhook (optional)

Get the webhook URL from the stack output:
```bash
aws cloudformation describe-stacks --stack-name your-project-self-healing-pipeline \
  --query 'Stacks[0].Outputs[?OutputKey==`SentryWebhookUrl`].OutputValue' --output text
```
Add it in Sentry: **Settings → Integrations → Webhooks → Add webhook URL**

### 10. Smoke test

```bash
SM_ARN=$(aws cloudformation describe-stacks --stack-name your-project-self-healing-pipeline \
  --query 'Stacks[0].Outputs[?OutputKey==`StateMachineArn`].OutputValue' --output text)

aws stepfunctions start-execution \
  --state-machine-arn "$SM_ARN" \
  --name "smoke-test-001" \
  --input '{
    "executionId": "smoke-test-001",
    "event": {
      "source": "manual",
      "severity": "medium",
      "type": "crash",
      "title": "SMOKE TEST: TypeError in auth endpoint",
      "stackTrace": "at registerAuthEndpoints (src/endpoints/auth/index.ts:52:5)",
      "affectedService": "your-api",
      "cloudwatchLogGroup": "/ecs/your-api",
      "triggeredAt": "2026-01-01T00:00:00Z"
    }
  }'
```

Expected: GitHub PR created in ~15–20 minutes, Slack notification received.

---

## Configuration

### Environment Variables (set via CloudFormation parameters)

| Variable | Description |
|----------|-------------|
| `GITHUB_TOKEN_SECRET_ARN` | Secrets Manager ARN for GitHub PAT |
| `SENTRY_WEBHOOK_SECRET_ARN` | Secrets Manager ARN for Sentry HMAC secret |
| `SENTRY_AUTH_TOKEN_SECRET_ARN` | Secrets Manager ARN for Sentry API token (optional) |
| `HEALER_AUDIT_BUCKET` | S3 bucket for pipeline state + audit logs |
| `HEALER_NOTIFICATION_TOPIC_ARN` | SNS topic for Slack notifications |
| `GITHUB_REPO_OWNER` | GitHub org/username |
| `GITHUB_REPO_NAME` | Repository name |
| `GITHUB_BASE_BRANCH` | Branch to PR against (default: `main`) |
| `BEDROCK_MODEL_ID` | Bedrock cross-region inference profile ID |
| `BEDROCK_REGION` | AWS region for Bedrock calls |

### File Path Allowlist

The FIX stage only applies diffs to files in these paths (edit `tasks/fix/run.ts`):

```typescript
const SAFE_PATH_PREFIXES = [
  "src/",
  "lib/",
  "packages/",
  // Add your project's source directories
];

const FORBIDDEN_PATH_PATTERNS = [
  /^infrastructure\//,
  /^\.github\//,
  /migrations\//,
  /^Dockerfile/,
  /\.ya?ml$/,
  /\.sh$/,
];
```

---

## Cost Estimate

| Component | Approximate monthly cost |
|-----------|------------------------|
| Step Functions | < $1 (state transitions) |
| Fargate (3 tasks × ~20 min per execution) | ~$0.15 per execution |
| Bedrock Claude Sonnet (2 calls per execution) | ~$0.50–$2 per execution |
| Lambda (6 invocations per execution) | Negligible |
| S3, DynamoDB, ECR | < $2/month |

**Typical cost: $2–5 per incident healed.** Rate limit (3/hour/service) prevents runaway spend.

---

## Security

- **Sentry webhook signature** — HMAC-SHA256 validation via `crypto.timingSafeEqual`
- **Prompt injection defense** — `sanitizeForPrompt()` strips injection phrases from Sentry/CloudWatch data before Bedrock calls
- **File path allowlist** — server-side validation blocks diffs targeting infrastructure, CI/CD, migrations
- **Secrets at runtime** — GitHub token and Sentry secret fetched from Secrets Manager at Lambda invocation time, never stored in plaintext environment variables
- **Scoped IAM** — 5 separate roles, `ecs:RunTask` limited to `healer-*` task definitions

---

## License

MIT — use freely, attribution appreciated.

---

## Contributing

PRs welcome. Key areas for improvement:
- Support for more languages beyond TypeScript/Node.js
- Better fix quality (multi-file diffs, context-aware patching)
- GitLab support alongside GitHub
- PagerDuty / Datadog trigger integrations
