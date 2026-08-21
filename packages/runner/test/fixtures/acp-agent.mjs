#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const mode = process.argv[2] ?? "success";
const fixtureConfig = await readFile(process.argv[3] ?? join(process.cwd(), ".acp-test-config.json"), "utf8")
  .then((value) => JSON.parse(value))
  .catch(() => ({}));

if (mode === "malformed-live") {
  await writeFile(join(process.cwd(), "acp-child-pid.txt"), `${process.pid}\n`);
  process.stdout.write("this is not an ACP frame\n");
  await new Promise(() => undefined);
}

if (mode === "oversized-complete" || mode === "oversized-incomplete") {
  await writeFile(join(process.cwd(), "acp-child-pid.txt"), `${process.pid}\n`);
  let requestBuffer = "";
  for await (const chunk of process.stdin) {
    requestBuffer += chunk.toString("utf8");
    const newline = requestBuffer.indexOf("\n");
    if (newline < 0) continue;
    const request = JSON.parse(requestBuffer.slice(0, newline));
    const frame = JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "opentag-test-agent", version: "1.0.0" },
        padding: "界".repeat(400_000)
      }
    });
    process.stdout.write(mode === "oversized-complete" ? `${frame}\n` : frame);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    process.exit(0);
  }
}

if (mode === "child-exit") {
  process.stderr.write("publish failed: token=SENTINEL_CHILD_STDERR_SECRET\n");
  process.exit(7);
}

const sessions = new Map();

async function record(cwd, name, value) {
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, name), `${JSON.stringify(value, null, 2)}\n`);
}

const app = acp
  .agent({ name: "opentag-test-agent" })
  .onRequest(acp.methods.agent.initialize, async (ctx) => {
    if (mode === "readiness-record") {
      await writeFile(join(process.cwd(), `acp-readiness-${process.pid}.json`), `${JSON.stringify({ pid: process.pid })}\n`);
    }
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      agentInfo: { name: "opentag-test-agent", version: "1.0.0" }
    };
  })
  .onRequest(acp.methods.agent.session.new, async (ctx) => {
    if (mode === "delay-session") {
      await record(ctx.params.cwd, "acp-session-new-started.json", { started: true });
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    const sessionId = crypto.randomUUID();
    const rawResultRequested = Array.isArray(ctx.params._meta?.claudeCode?.emitRawSDKMessages) &&
      ctx.params._meta.claudeCode.emitRawSDKMessages.some((filter) => filter?.type === "result");
    sessions.set(sessionId, { cwd: ctx.params.cwd, cancelled: false, rawResultRequested, promptCount: 0 });
    await record(ctx.params.cwd, "acp-session.json", {
      cwd: ctx.params.cwd,
      mcpServers: ctx.params.mcpServers,
      pid: process.pid,
      rawResultRequested,
      inheritedSecret: process.env.OPENTAG_ACP_HOST_SECRET ?? null,
      explicitValue: process.env.OPENTAG_ACP_EXPLICIT ?? null
    });
    return {
      sessionId,
      ...(mode === "session-mode"
        ? {
            modes: {
              currentModeId: "auto",
              availableModes: [
                { id: "auto", name: "Auto" },
                { id: "default", name: "Default" }
              ]
            }
          }
        : {})
    };
  })
  .onRequest(acp.methods.agent.session.setMode, async (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (!session) throw new Error("unknown test session");
    await record(session.cwd, "acp-session-mode.json", { modeId: ctx.params.modeId });
    return {};
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (!session) throw new Error("unknown test session");
    session.promptCount += 1;
    const text = ctx.params.prompt
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    await record(session.cwd, "acp-prompt.json", { text, promptCount: session.promptCount });

    if (mode === "empty-output" || (mode === "empty-first" && session.promptCount === 1)) {
      return { stopReason: "end_turn" };
    }

    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "plan",
        entries: [{ content: "Complete the OpenTag run", priority: "high", status: "in_progress" }]
      }
    });
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: fixtureConfig.OPENTAG_ACP_TEST_TOOL_TITLE ?? "Write ACP output",
        kind: "edit",
        status: "in_progress"
      }
    });

    if (mode === "permission") {
      const permission = await ctx.client.request(acp.methods.client.session.requestPermission, {
        sessionId: ctx.params.sessionId,
        toolCall: {
          toolCallId: "material-1",
          title: fixtureConfig.OPENTAG_ACP_TEST_PERMISSION_TITLE ?? "Publish report",
          kind: fixtureConfig.OPENTAG_ACP_TEST_PERMISSION_KIND ?? "execute",
          status: "pending",
          rawInput: {
            provider: fixtureConfig.OPENTAG_ACP_TEST_PROVIDER ?? "npm",
            connectionId: fixtureConfig.OPENTAG_ACP_TEST_CONNECTION ?? "npm:team",
            ...(fixtureConfig.OPENTAG_ACP_TEST_OMIT_RESOURCE === "true"
              ? {}
              : { package: fixtureConfig.OPENTAG_ACP_TEST_RESOURCE ?? "@acme/report" }),
            tag: fixtureConfig.OPENTAG_ACP_TEST_VERSION ?? "next",
            ...(fixtureConfig.OPENTAG_ACP_TEST_ENVIRONMENT ? { environment: fixtureConfig.OPENTAG_ACP_TEST_ENVIRONMENT } : {}),
            ...(fixtureConfig.OPENTAG_ACP_TEST_FORCE ? { force: fixtureConfig.OPENTAG_ACP_TEST_FORCE === "true" } : {}),
            ...(fixtureConfig.OPENTAG_ACP_TEST_VISIBILITY ? { visibility: fixtureConfig.OPENTAG_ACP_TEST_VISIBILITY } : {}),
            authorization: `Bearer ${fixtureConfig.OPENTAG_ACP_TEST_SECRET ?? "fixture-secret-token"}`
          }
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-run", name: "Allow for session", kind: "allow_always" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" }
        ]
      });
      await record(session.cwd, "acp-permission.json", permission);
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "material-1",
          status: "completed"
        }
      });
    }

    if (mode === "cancel" || mode === "cancel-notify-failure") {
      await writeFile(join(session.cwd, "acp-output.txt"), "recoverable cancellation delta\n");
      await record(session.cwd, "acp-waiting.json", { waiting: true });
      if (mode === "cancel-notify-failure") process.stdin.destroy();
      while (!session.cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await record(session.cwd, "acp-cancelled.json", { cancelled: true });
      return { stopReason: "cancelled" };
    }

    if (mode === "cancel-process-tree") {
      const descendant = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1_000)"], {
        stdio: "ignore"
      });
      await record(session.cwd, "acp-descendant.json", { pid: descendant.pid });
      await new Promise(() => undefined);
    }

    await writeFile(join(session.cwd, "acp-output.txt"), "created by the ACP fixture\n");
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed"
      }
    });
    if (mode === "raw-result-only" || mode === "raw-result-and-stream") {
      if (session.rawResultRequested) {
        await ctx.client.notify("_claude/sdkMessage", {
          sessionId: ctx.params.sessionId,
          message: {
            type: "result",
            subtype: "success",
            is_error: false,
            origin: { kind: "human" },
            result: mode === "raw-result-and-stream"
              ? "Clean terminal result."
              : fixtureConfig.OPENTAG_ACP_TEST_OUTPUT ?? "Raw SDK result fallback completed the requested work."
          }
        });
      }
      if (mode === "raw-result-only") return { stopReason: "end_turn" };
    }
    const messageChunks = mode === "chunked-output"
      ? ["OPENTAG_", "CHUNK_OK"]
      : [mode === "raw-result-and-stream"
          ? "dirty stream </think><arg_value>"
          : fixtureConfig.OPENTAG_ACP_TEST_OUTPUT ?? "ACP fixture completed the requested work."];
    for (const text of messageChunks) {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text }
        }
      });
    }
    return { stopReason: mode === "refusal" ? "refusal" : "end_turn" };
  })
  .onNotification(acp.methods.agent.session.cancel, async (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (session) session.cancelled = true;
  });

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
await app.connect(stream);
