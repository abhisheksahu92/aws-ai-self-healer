import { handler } from "../stage-notify/index";
import axios from "axios";
import * as s3Client from "../shared/s3-client";
import { PipelineState } from "../shared/types";

jest.mock("axios");
jest.mock("../shared/s3-client");

const mockPost = jest.spyOn(axios, "post").mockResolvedValue({ data: "ok" });

const state: PipelineState = {
  executionId: "exec-003",
  prUrl: "https://github.com/YOUR-GITHUB-ORG/your-repo/pull/99",
  prNumber: 99,
  event: {
    source: "sentry",
    severity: "critical",
    type: "crash",
    title: "Fatal: unhandled rejection",
    affectedService: "your-api",
    cloudwatchLogGroup: "/ecs/dev-your-api",
    triggeredAt: "2026-05-18T04:00:00Z",
  },
  investigation: {
    rootCauseHypothesis: "Missing null check",
    confidenceScore: 90,
    affectedFiles: ["src/auth/index.ts"],
    fixStrategy: "Add null guard",
    rawBedrockResponse: "",
  },
};

const mockReadState = jest.spyOn(s3Client, "readPipelineState").mockResolvedValue(state);

describe("Stage 6 NOTIFY", () => {
  beforeEach(() => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/test";
    jest.clearAllMocks();
    mockReadState.mockResolvedValue(state);
  });

  it("posts a Slack message with PR link", async () => {
    await handler({ executionId: "exec-003" });
    expect(mockPost).toHaveBeenCalledWith(
      "https://hooks.slack.com/services/test",
      expect.objectContaining({ text: expect.stringContaining("#99") }),
      expect.any(Object),
    );
  });

  it("does not throw if Slack webhook fails", async () => {
    mockPost.mockRejectedValueOnce(new Error("Slack down"));
    await expect(handler({ executionId: "exec-003" })).resolves.not.toThrow();
  });
});
