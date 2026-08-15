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
});
