import { describe, expect, it } from "vitest";
import { startNodeServer } from "../src/node-server.js";

describe("Node HTTP process lifecycle", () => {
  it("stops admission before draining PostgreSQL and closes once", async () => {
    const events: string[] = [];
    let closeCallback: (() => void) | undefined;
    const service = startNodeServer({
      application: {
        async fetch() {
          return new Response("ok");
        },
      },
      host: "127.0.0.1",
      port: 3000,
      serveAdapter() {
        events.push("listen");
        return {
          close(callback) {
            events.push("http-close-requested");
            closeCallback = callback;
          },
        };
      },
      async drain() {
        events.push("postgres-drained");
      },
    });

    const firstClose = service.close();
    const secondClose = service.close();
    expect(events).toEqual(["listen", "http-close-requested"]);
    closeCallback?.();
    await Promise.all([firstClose, secondClose]);
    expect(events).toEqual([
      "listen",
      "http-close-requested",
      "postgres-drained",
    ]);
  });

  it("drains PostgreSQL even when the HTTP server reports a close error", async () => {
    const events: string[] = [];
    const closeError = new Error("http close failed");
    const service = startNodeServer({
      application: {
        async fetch() {
          return new Response("ok");
        },
      },
      host: "127.0.0.1",
      port: 3000,
      serveAdapter() {
        return {
          close(callback) {
            events.push("http-close-failed");
            callback(closeError);
          },
        };
      },
      async drain() {
        events.push("postgres-drained");
      },
    });

    await expect(service.close()).rejects.toBe(closeError);
    expect(events).toEqual(["http-close-failed", "postgres-drained"]);
  });
});
