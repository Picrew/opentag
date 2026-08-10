import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OpenTagEventSchema, OpenTagRunResultSchema, type OpenTagEvent, type OpenTagRunResult } from "@opentag/core";
import { createDispatcherApp } from "../src/server.js";

type ReplayFixture = {
  name: string;
  runId: string;
  event: OpenTagEvent;
  executorCapability: Record<string, unknown>;
  result: OpenTagRunResult;
  expected: {
    artifactTypes: string[];
    ledgerCategories: string[];
    finalBodyContains: string[];
  };
};

function jsonRequest(body: unknown) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

function channelPrincipalJsonRequest(body: unknown, credential: string) {
  const request = jsonRequest(body);
  return {
    ...request,
    headers: { ...request.headers, "x-opentag-channel-principal": credential }
  };
}

function loadFixture(name: string): ReplayFixture {
  const raw = JSON.parse(readFileSync(new URL(`./fixtures/replay/${name}.json`, import.meta.url), "utf8")) as ReplayFixture;
  return {
    ...raw,
    event: OpenTagEventSchema.parse(raw.event),
    result: OpenTagRunResultSchema.parse(raw.result)
  };
}

const fixtures = [
  loadFixture("github-governed-loop"),
  loadFixture("slack-governed-loop"),
  loadFixture("gitlab-live-derived-loop"),
  loadFixture("lark-live-derived-loop")
];

function repoBindingFor(event: OpenTagEvent): { provider: string; owner: string; repo: string } {
  const metadata = event.metadata ?? {};
  const provider = typeof metadata.repoProvider === "string" ? metadata.repoProvider : event.source;
  const owner = typeof metadata.owner === "string" ? metadata.owner : "acme";
  const repo = typeof metadata.repo === "string" ? metadata.repo : "demo";
  return { provider, owner, repo };
}

function managedChannelReplayConfig(event: OpenTagEvent) {
  if (event.source !== "slack" && event.source !== "lark") return undefined;
  const metadata = event.metadata ?? {};
  const accountId = event.source === "slack" ? metadata.teamId : metadata.tenantKey;
  const conversationId = event.source === "slack" ? metadata.channelId : metadata.chatId;
  if (typeof accountId !== "string" || typeof conversationId !== "string") {
    throw new Error(`Replay fixture has incomplete ${event.source} channel identity.`);
  }
  const applicationId = `${event.source}_replay_app`;
  const credential = `${event.source}_replay_principal`;
  return {
    credential,
    principal: { provider: event.source, applicationId, credential },
    binding: {
      provider: event.source,
      accountId,
      conversationId,
      ownership: { mode: "managed", exclusive: true, applicationId }
    }
  };
}

function expectSourceThreadBodyIsRedacted(body: string) {
  expect(body).not.toMatch(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/);
  expect(body).not.toMatch(/\bglpat-[A-Za-z0-9_-]{20,}\b/);
  expect(body).not.toMatch(/\bx(?:ox[baprs]|app)-[A-Za-z0-9-]{20,}\b/);
  expect(body).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  expect(body).not.toMatch(/\/Users\/[A-Za-z0-9._-]+\/(?:repos|Library|Desktop|Downloads|\.config)\//);
  expect(body).not.toMatch(/\bom_[A-Za-z0-9]{20,}\b/);
  expect(body).not.toContain("proposal_");
  expect(body).not.toContain("intent_");
  expect(body).not.toContain("stdout:");
  expect(body).not.toContain("stderr:");
}

describe("source-thread replay harness", () => {
  for (const fixture of fixtures) {
    it(`replays ${fixture.name}`, async () => {
      const delivered: Array<{ kind: string; body: string }> = [];
      const managedChannel = managedChannelReplayConfig(fixture.event);
      const app = createDispatcherApp({
        databasePath: ":memory:",
        ...(managedChannel ? { channelPrincipals: [managedChannel.principal] } : {}),
        callbackSink: {
          async deliver(message) {
            delivered.push({ kind: message.kind, body: message.body });
            return { handled: true, outcome: "accepted" } as const;
          }
        }
      });

      await expect(
        app.request("/v1/runners", jsonRequest({ runnerId: "runner_1", name: "Replay Runner" }))
      ).resolves.toMatchObject({ status: 201 });
      const repoBinding = repoBindingFor(fixture.event);
      await expect(
        app.request(
          "/v1/repo-bindings",
          jsonRequest({
            provider: repoBinding.provider,
            owner: repoBinding.owner,
            repo: repoBinding.repo,
            runnerId: "runner_1",
            workspacePath: "/Users/test/demo",
            defaultExecutor: "echo",
            allowedActors: ["octocat", "alice", "ming", "gitlab-user"]
          })
        )
      ).resolves.toMatchObject({ status: 201 });
      if (managedChannel) {
        await expect(
          app.request(
            "/v1/channel-bindings",
            channelPrincipalJsonRequest(
              {
                ...managedChannel.binding,
                repoProvider: repoBinding.provider,
                owner: repoBinding.owner,
                repo: repoBinding.repo
              },
              managedChannel.credential
            )
          )
        ).resolves.toMatchObject({ status: 201 });
      }

      const runRequest = { runId: fixture.runId, event: fixture.event };
      const createResponse = await app.request(
        "/v1/runs",
        managedChannel
          ? channelPrincipalJsonRequest(runRequest, managedChannel.credential)
          : jsonRequest(runRequest)
      );
      expect(createResponse.status).toBe(201);

      const claimResponse = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
      expect(claimResponse.status).toBe(200);
      const lease = (await claimResponse.json()) as { attemptId: string; fencingToken: string };

      const runningResponse = await app.request(
        `/v1/runners/runner_1/runs/${fixture.runId}/running`,
        jsonRequest({
          executor: "echo",
          attemptId: lease.attemptId,
          fencingToken: lease.fencingToken,
          executorCapability: fixture.executorCapability,
          idempotencyKey: `runner_1:${fixture.runId}:running`
        })
      );
      expect(runningResponse.status).toBe(200);

      const completeResponse = await app.request(
        `/v1/runners/runner_1/runs/${fixture.runId}/complete`,
        jsonRequest({
          result: fixture.result,
          attemptId: lease.attemptId,
          fencingToken: lease.fencingToken,
          idempotencyKey: `runner_1:${fixture.runId}:complete`
        })
      );
      expect(completeResponse.status).toBe(200);

      const runResponse = await app.request(`/v1/runs/${fixture.runId}`);
      expect(runResponse.status).toBe(200);
      const { run } = (await runResponse.json()) as { run: { result?: OpenTagRunResult } };
      const artifactTypes = run.result?.artifacts?.map((artifact) => artifact.type) ?? [];
      expect(artifactTypes).toEqual(expect.arrayContaining(fixture.expected.artifactTypes));
      expect(run.result?.artifacts?.every((artifact) => artifact.sourceRunId === fixture.runId)).toBe(true);

      const ledgerResponse = await app.request(`/v1/runs/${fixture.runId}/ledger`);
      expect(ledgerResponse.status).toBe(200);
      const { ledger } = (await ledgerResponse.json()) as { ledger: { entries: Array<{ category: string; type: string }> } };
      expect(ledger.entries.map((entry) => entry.category)).toEqual(expect.arrayContaining(fixture.expected.ledgerCategories));
      expect(ledger.entries.map((entry) => entry.type)).toEqual(
        expect.arrayContaining(["source_event.received", "context_packet.generated", "executor.capability.snapshot", "artifact.created", "run.completed"])
      );

      const final = delivered.find((message) => message.kind === "final");
      expect(final).toBeDefined();
      for (const expectedText of fixture.expected.finalBodyContains) {
        expect(final?.body).toContain(expectedText);
      }
      expectSourceThreadBodyIsRedacted(final?.body ?? "");
    });
  }
});
