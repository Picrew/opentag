import { serve } from "@hono/node-server";
import type { ControlPlaneApplication } from "./application.js";
import { createConsoleAssetApplication } from "./console-assets.js";

type ClosableServer = {
  close(callback: (error?: Error) => void): void;
};

type ServeAdapter = (input: {
  fetch: ControlPlaneApplication["fetch"];
  hostname: string;
  port: number;
}) => ClosableServer;

export function startNodeServer(input: {
  application: ControlPlaneApplication;
  host: string;
  port: number;
  drain(): Promise<void>;
  consoleAssetsDirectory?: string;
  serveAdapter?: ServeAdapter;
}) {
  const serveAdapter = input.serveAdapter ?? serve;
  const application = input.consoleAssetsDirectory
    ? createConsoleAssetApplication({
        application: input.application,
        assetsDirectory: input.consoleAssetsDirectory,
      })
    : input.application;
  const server = serveAdapter({
    fetch: application.fetch,
    hostname: input.host,
    port: input.port,
  });
  let closePromise: Promise<void> | undefined;
  return {
    close() {
      closePromise ??= new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          input.drain().then(resolve, reject);
        });
      });
      return closePromise;
    },
  };
}
