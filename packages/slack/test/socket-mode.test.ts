import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { startSlackSocketModeApp } from "../src/socket-mode.js";

class FakeWebSocket extends EventEmitter {
  readonly sent: string[] = [];
  closeCalled = false;

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closeCalled = true;
    this.emit("close");
  }
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

describe("Slack Socket Mode", () => {
  it("acks Socket Mode envelopes and processes app mentions through the shared Slack handler", async () => {
    const socket = new FakeWebSocket();
    let socketCreated = false;
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, url: "wss://slack.example/socket" })) as unknown as typeof fetch;
    const handle = startSlackSocketModeApp(
      {
        appToken: "xapp-token",
        slackApp: {
          agentId: "opentag",
          appId: "A123"
        },
        async resolveChannelBinding() {
          return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
        },
        createRun,
        now: () => "2024-06-24T00:00:00.000Z"
      },
      {
        fetchImpl,
        reconnectDelayMs: 1,
        createWebSocket(url) {
          expect(url).toBe("wss://slack.example/socket");
          socketCreated = true;
          return socket as unknown as WebSocket;
        },
        log() {},
        logError() {}
      }
    );

    await eventually(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await eventually(() => expect(socketCreated).toBe(true));
    await Promise.resolve();
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "events_api",
          envelope_id: "envelope_1",
          payload: {
            type: "event_callback",
            api_app_id: "A123",
            team_id: "T123",
            event_id: "Ev123",
            event_time: 1719187200,
            authorizations: [{ user_id: "U_APP" }],
            event: {
              type: "app_mention",
              user: "U456",
              text: "<@U_APP> fix this",
              ts: "1719187200.000100",
              channel: "C123"
            }
          }
        })
      )
    );

    await eventually(() => expect(createRun).toHaveBeenCalledOnce());
    expect(socket.sent).toEqual([JSON.stringify({ envelope_id: "envelope_1" })]);
    expect(createRun.mock.calls[0]?.[0]).toMatchObject({
      source: "slack",
      target: {
        agentId: "opentag",
        mention: "<@U_APP>"
      },
      metadata: {
        slackAppId: "A123",
        teamId: "T123",
        channelId: "C123"
      }
    });

    await handle.close();
    expect(socket.closeCalled).toBe(true);
  });

  it("processes Block Kit button actions through Socket Mode", async () => {
    const socket = new FakeWebSocket();
    let socketCreated = false;
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const submitThreadAction = vi.fn(async () => ({}));
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, url: "wss://slack.example/socket" })) as unknown as typeof fetch;
    const handle = startSlackSocketModeApp(
      {
        appToken: "xapp-token",
        slackApp: {
          agentId: "opentag",
          appId: "A123",
          callbackUri: "https://slack.com/api/chat.postMessage"
        },
        async resolveChannelBinding() {
          return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
        },
        createRun,
        submitThreadAction,
        now: () => "2024-06-24T00:00:00.000Z"
      },
      {
        fetchImpl,
        reconnectDelayMs: 1,
        createWebSocket(url) {
          expect(url).toBe("wss://slack.example/socket");
          socketCreated = true;
          return socket as unknown as WebSocket;
        },
        log() {},
        logError() {}
      }
    );

    await eventually(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await eventually(() => expect(socketCreated).toBe(true));
    await Promise.resolve();
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "interactive",
          envelope_id: "envelope_button_1",
          payload: {
            type: "block_actions",
            api_app_id: "A123",
            team: { id: "T123" },
            user: { id: "U456", username: "alice" },
            channel: { id: "C123" },
            message: {
              ts: "1719187200.000500",
              thread_ts: "1719187200.000100"
            },
            trigger_id: "trigger_apply_1",
            actions: [
              {
                type: "button",
                action_id: "opentag:apply:1",
                block_id: "opentag_actions_1",
                value: JSON.stringify({
                  version: 1,
                  command: "apply 1",
                  proposalId: "proposal_1",
                  intentId: "intent_label_1",
                  permissionDecision: "allow_run",
                  proposalHash: "proposal_hash_1",
                  actionId: "action_governed_1"
                }),
                action_ts: "1719187200.000600"
              }
            ]
          }
        })
      )
    );

    await eventually(() => expect(submitThreadAction).toHaveBeenCalledOnce());
    expect(createRun).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([JSON.stringify({ envelope_id: "envelope_button_1" })]);
    expect(submitThreadAction).toHaveBeenCalledWith({
      id: "approval_slack_block_trigger_apply_1",
      rawText: "apply 1",
      actor: {
        provider: "slack",
        providerUserId: "U456",
        handle: "alice",
        organizationId: "T123"
      },
      callback: {
        provider: "slack",
        uri: "https://slack.com/api/chat.postMessage",
        threadKey: "T123|C123|1719187200.000100"
      },
      metadata: {
        source: "slack_button",
        teamId: "T123",
        channelId: "C123",
        messageTs: "1719187200.000500",
        slackAppId: "A123",
        actionId: "opentag:apply:1",
        blockId: "opentag_actions_1",
        actionTs: "1719187200.000600",
        proposalId: "proposal_1",
        intentId: "intent_label_1",
        permissionDecision: "allow_run",
        proposalHash: "proposal_hash_1",
        governedActionId: "action_governed_1",
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      }
    });

    await handle.close();
    expect(socket.closeCalled).toBe(true);
  });

  it("processes self-service doctor commands through Socket Mode without creating a run", async () => {
    const socket = new FakeWebSocket();
    let socketCreated = false;
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const reply = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, url: "wss://slack.example/socket" })) as unknown as typeof fetch;
    const handle = startSlackSocketModeApp(
      {
        appToken: "xapp-token",
        slackApp: {
          agentId: "opentag",
          appId: "A123"
        },
        async resolveChannelBinding() {
          return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
        },
        createRun,
        reply,
        now: () => "2024-06-24T00:00:00.000Z"
      },
      {
        fetchImpl,
        reconnectDelayMs: 1,
        createWebSocket(url) {
          expect(url).toBe("wss://slack.example/socket");
          socketCreated = true;
          return socket as unknown as WebSocket;
        },
        log() {},
        logError() {}
      }
    );

    await eventually(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await eventually(() => expect(socketCreated).toBe(true));
    await Promise.resolve();
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "events_api",
          envelope_id: "envelope_doctor_1",
          payload: {
            type: "event_callback",
            api_app_id: "A123",
            team_id: "T123",
            event_id: "EvDoctor",
            event_time: 1719187200,
            authorizations: [{ user_id: "U_APP" }],
            event: {
              type: "app_mention",
              user: "U456",
              text: "<@U_APP> /doctor",
              ts: "1719187200.000100",
              channel: "C123"
            }
          }
        })
      )
    );

    await eventually(() => expect(reply).toHaveBeenCalledOnce());
    expect(createRun).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([JSON.stringify({ envelope_id: "envelope_doctor_1" })]);
    expect(reply).toHaveBeenCalledWith({
      cause: expect.objectContaining({
        assurance: "authenticated_socket_mode",
        channelId: "C123",
        command: "doctor",
        threadTs: "1719187200.000100"
      }),
      presentation: {
        text: expect.stringContaining("OpenTag doctor (redacted):"),
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: "section",
            text: expect.objectContaining({ text: "*OpenTag doctor (redacted):*" })
          })
        ])
      }
    });

    await handle.close();
    expect(socket.closeCalled).toBe(true);
  });

  it("processes self-service stop commands through Socket Mode without creating a run", async () => {
    const socket = new FakeWebSocket();
    let socketCreated = false;
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const stopRun = vi.fn(async () => ({ outcome: "not_found" as const }));
    const reply = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, url: "wss://slack.example/socket" })) as unknown as typeof fetch;
    const handle = startSlackSocketModeApp(
      {
        appToken: "xapp-token",
        slackApp: {
          agentId: "opentag",
          appId: "A123"
        },
        async resolveChannelBinding() {
          return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
        },
        createRun,
        stopRun,
        reply,
        now: () => "2024-06-24T00:00:00.000Z"
      },
      {
        fetchImpl,
        reconnectDelayMs: 1,
        createWebSocket(url) {
          expect(url).toBe("wss://slack.example/socket");
          socketCreated = true;
          return socket as unknown as WebSocket;
        },
        log() {},
        logError() {}
      }
    );

    await eventually(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await eventually(() => expect(socketCreated).toBe(true));
    await Promise.resolve();
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "events_api",
          envelope_id: "envelope_stop_1",
          payload: {
            type: "event_callback",
            api_app_id: "A123",
            team_id: "T123",
            event_id: "EvStop",
            event_time: 1719187200,
            authorizations: [{ user_id: "U_APP" }],
            event: {
              type: "app_mention",
              user: "U456",
              text: "<@U_APP> /stop",
              ts: "1719187200.000100",
              channel: "C123"
            }
          }
        })
      )
    );

    await eventually(() => expect(stopRun).toHaveBeenCalledOnce());
    expect(createRun).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([JSON.stringify({ envelope_id: "envelope_stop_1" })]);
    expect(stopRun).toHaveBeenCalledWith({
      teamId: "T123",
      channelId: "C123",
      requestedBy: "slack:U456"
    });
    expect(reply).toHaveBeenCalledWith({
      cause: expect.objectContaining({ channelId: "C123", command: "stop", threadTs: "1719187200.000100" }),
      presentation: { text: "No active run was found for this Slack channel and Project Target." }
    });

    await handle.close();
    expect(socket.closeCalled).toBe(true);
  });

  it("requires explicit confirmation before unbinding a Slack channel through Socket Mode", async () => {
    const socket = new FakeWebSocket();
    let socketCreated = false;
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const unbindChannel = vi.fn(async () => {});
    const reply = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, url: "wss://slack.example/socket" })) as unknown as typeof fetch;
    const handle = startSlackSocketModeApp(
      {
        appToken: "xapp-token",
        slackApp: {
          agentId: "opentag",
          appId: "A123"
        },
        async resolveChannelBinding() {
          return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
        },
        createRun,
        canManageBinding: vi.fn(async () => true),
        unbindChannel,
        reply,
        now: () => "2024-06-24T00:00:00.000Z"
      },
      {
        fetchImpl,
        reconnectDelayMs: 1,
        createWebSocket(url) {
          expect(url).toBe("wss://slack.example/socket");
          socketCreated = true;
          return socket as unknown as WebSocket;
        },
        log() {},
        logError() {}
      }
    );

    await eventually(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await eventually(() => expect(socketCreated).toBe(true));
    await Promise.resolve();
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "events_api",
          envelope_id: "envelope_unbind_usage_1",
          payload: {
            type: "event_callback",
            api_app_id: "A123",
            team_id: "T123",
            event_id: "EvUnbindUsage",
            event_time: 1719187200,
            authorizations: [{ user_id: "U_APP" }],
            event: {
              type: "app_mention",
              user: "U456",
              text: "<@U_APP> /unbind",
              ts: "1719187200.000100",
              channel: "C123"
            }
          }
        })
      )
    );

    await eventually(() => expect(reply).toHaveBeenCalledOnce());
    expect(createRun).not.toHaveBeenCalled();
    expect(unbindChannel).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      cause: expect.objectContaining({ channelId: "C123", command: "unbind", threadTs: "1719187200.000100" }),
      presentation: { text: expect.stringContaining("/unbind confirm") }
    });

    await handle.close();
    expect(socket.closeCalled).toBe(true);
  });

  it("unbinds a Slack channel after explicit confirmation through Socket Mode", async () => {
    const socket = new FakeWebSocket();
    let socketCreated = false;
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const unbindChannel = vi.fn(async () => {});
    const reply = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, url: "wss://slack.example/socket" })) as unknown as typeof fetch;
    const handle = startSlackSocketModeApp(
      {
        appToken: "xapp-token",
        slackApp: {
          agentId: "opentag",
          appId: "A123"
        },
        async resolveChannelBinding() {
          return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
        },
        createRun,
        canManageBinding: vi.fn(async () => true),
        unbindChannel,
        reply,
        now: () => "2024-06-24T00:00:00.000Z"
      },
      {
        fetchImpl,
        reconnectDelayMs: 1,
        createWebSocket(url) {
          expect(url).toBe("wss://slack.example/socket");
          socketCreated = true;
          return socket as unknown as WebSocket;
        },
        log() {},
        logError() {}
      }
    );

    await eventually(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await eventually(() => expect(socketCreated).toBe(true));
    await Promise.resolve();
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "events_api",
          envelope_id: "envelope_unbind_1",
          payload: {
            type: "event_callback",
            api_app_id: "A123",
            team_id: "T123",
            event_id: "EvUnbind",
            event_time: 1719187200,
            authorizations: [{ user_id: "U_APP" }],
            event: {
              type: "app_mention",
              user: "U456",
              text: "<@U_APP> /unbind confirm",
              ts: "1719187200.000100",
              channel: "C123"
            }
          }
        })
      )
    );

    await eventually(() => expect(unbindChannel).toHaveBeenCalledOnce());
    expect(createRun).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([JSON.stringify({ envelope_id: "envelope_unbind_1" })]);
    expect(unbindChannel).toHaveBeenCalledWith({
      teamId: "T123",
      channelId: "C123"
    });
    expect(reply).toHaveBeenCalledWith({
      cause: expect.objectContaining({ channelId: "C123", command: "unbind", threadTs: "1719187200.000100" }),
      presentation: { text: expect.stringContaining("Disconnected this Slack channel from Project Target github:acme/demo") }
    });

    await handle.close();
    expect(socket.closeCalled).toBe(true);
  });

  it("retries after a transient apps.connections.open failure instead of rejecting the start promise", async () => {
    const socket = new FakeWebSocket();
    let socketCreated = false;
    // First open attempt fails (Slack returns ok:false), second succeeds. A
    // rejecting startPromise would abort the entire OpenTag daemon, so the loop
    // must swallow the transient failure and retry.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: false, error: "ratelimited" }))
      .mockResolvedValue(Response.json({ ok: true, url: "wss://slack.example/socket" })) as unknown as typeof fetch;

    let rejected = false;
    const handle = startSlackSocketModeApp(
      {
        appToken: "xapp-token",
        slackApp: {
          agentId: "opentag",
          appId: "A123"
        },
        async resolveChannelBinding() {
          return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
        },
        createRun: vi.fn(async () => ({ runId: "run_1" })),
        now: () => "2024-06-24T00:00:00.000Z"
      },
      {
        fetchImpl,
        reconnectDelayMs: 1,
        createWebSocket() {
          socketCreated = true;
          return socket as unknown as WebSocket;
        },
        log() {},
        logError() {}
      }
    );

    handle.startPromise.catch(() => {
      rejected = true;
    });

    // The first attempt fails; the second attempt must run and open the socket.
    await eventually(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await eventually(() => expect(socketCreated).toBe(true));
    expect(rejected).toBe(false);

    await handle.close();
    // close() awaits startPromise; if it had rejected, the flag would be set.
    expect(rejected).toBe(false);
  });

  it("rejects the start promise on a terminal auth error instead of retrying forever", async () => {
    let socketCreated = false;
    const recordControlPlaneEvent = vi.fn(async () => {});
    // Slack returns a terminal auth failure. Retrying would loop forever against
    // the API, so startPromise must reject and the open must not be reattempted.
    const fetchImpl = vi.fn(async () => Response.json({ ok: false, error: "invalid_auth" })) as unknown as typeof fetch;

    const handle = startSlackSocketModeApp(
      {
        appToken: "xapp-bad-token",
        slackApp: {
          agentId: "opentag",
          appId: "A123"
        },
        async resolveChannelBinding() {
          return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
        },
        createRun: vi.fn(async () => ({ runId: "run_1" })),
        recordControlPlaneEvent,
        now: () => "2024-06-24T00:00:00.000Z"
      },
      {
        fetchImpl,
        reconnectDelayMs: 1,
        createWebSocket() {
          socketCreated = true;
          return new FakeWebSocket() as unknown as WebSocket;
        },
        log() {},
        logError() {}
      }
    );

    await expect(handle.startPromise).rejects.toThrow(/invalid_auth/);
    // A terminal error must not be retried, so only one open attempt happens and
    // no socket is ever created.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(socketCreated).toBe(false);
    expect(recordControlPlaneEvent).toHaveBeenCalledWith({
      type: "security.token_misuse",
      severity: "warn",
      subject: "slack:app_token",
      payload: {
        provider: "slack",
        endpoint: "apps.connections.open",
        reason: "invalid_auth",
        tokenKind: "app_token",
        mode: "socket_mode",
        agentId: "opentag",
        appId: "A123"
      }
    });
    expect(JSON.stringify(recordControlPlaneEvent.mock.calls)).not.toContain("xapp-bad-token");

    // close() must remain safe to call even after a rejected startPromise.
    await expect(handle.close()).resolves.toBeUndefined();
  });
});
