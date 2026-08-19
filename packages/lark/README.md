# @opentag/lark

Lark / Feishu adapter helpers for OpenTag.

Use this package to receive Lark Personal Agent messages, normalize them into OpenTag events, register a Personal Agent by QR scan, and send local replies through the OpenTag dispatcher.

## Install

```bash
pnpm add @opentag/lark
```

## Exports

- `createLarkMessageHandler`: handles `im.message.receive_v1` events.
- `startLarkIngress`: starts a Lark long-connection ingress.
- `registerLarkPersonalAgent`: creates a Personal Agent registration flow.
- `normalizeLarkMessage`: converts Lark messages into `OpenTagEvent` objects.
- `renderLarkFinalResult`: renders OpenTag run results for Lark.

## Example

```ts
import { startLarkIngress } from "@opentag/lark";

const ingress = startLarkIngress({
  appId: process.env.LARK_APP_ID!,
  appSecret: process.env.LARK_APP_SECRET!,
  domain: "lark",
  dispatcherUrl: "http://localhost:3030",
  agentId: "opentag",
  conversationMemory: {
    enabled: true,
    maxRuns: 300,
    maxCharacters: 600_000,
    maxTurnCharacters: 50_000
  }
});

await ingress.startPromise;
```

Conversation memory is local, bounded, and opt-out. Direct messages share one
conversation per tenant and chat; group messages are isolated by root thread.
Only successful runs for the same Project Target are included. The defaults
retain up to 300 runs, 600,000 characters overall, and 50,000 characters per
turn. These limits control prompt history, not the model's response length. Set
`conversationMemory.enabled` to `false` to keep every run stateless.

## Stability

The event normalization and ingress config shapes are public adapter contracts. Add optional fields instead of changing existing required fields.
