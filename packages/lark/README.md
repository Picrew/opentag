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
- `createFeishuOpenApiClient`: calls OpenAPI with a refreshable user token.
- `createFeishuTools`: exposes bounded readers for documents, Drive, Wiki,
  Sheets, Bitable, chat history, and message resources.
- `createFeishuResourceContextResolver`: preloads explicit resource URLs and
  current-message attachments into agent context.

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
    maxRuns: 100,
    maxCharacters: 160_000,
    maxTurnCharacters: 20_000
  }
});

await ingress.startPromise;
```

Conversation memory is local, bounded, and opt-out. Direct messages share one
conversation per tenant and chat; group messages are isolated by root thread.
Only successful runs for the same Project Target are included. The defaults
retain up to 100 runs, 160,000 characters overall, and 20,000 characters per
turn. These limits control prompt history, not the model's response length. Set
`conversationMemory.enabled` to `false` to keep every run stateless.

## User Resource Access

The resource layer uses `user_access_token` by default. The authorizing user's
ACL and the app's API scopes both apply. The public readers keep resource
discovery separate from content reading: Drive returns typed tokens, Wiki nodes
resolve to `obj_token` / `obj_type`, and message attachments use the IM resource
API rather than Drive.

`createFeishuTools` returns `readDocument`, `readDocumentBlocks`, `listDrive`,
`walkDrive`, `listWikiSpaces`, `listWikiNodes`, `readWikiNode`,
`getChatHistory`, `getMessage`, `downloadMessageFile`, and the unified
`readResource` dispatcher. Downloaded text, PDF, DOCX, PPTX, XLSX,
OpenDocument, and RTF resources can be converted to bounded text. Downloads and
parsing are capped at 100 MB; OCR, transcription, and embedded-attachment
extraction are disabled.

For the CLI integration and required OAuth scopes, see the
[English](../../docs/platforms/lark.en.md) or
[Chinese](../../docs/platforms/lark.zh-CN.md) platform guide.

## Stability

The event normalization and ingress config shapes are public adapter contracts. Add optional fields instead of changing existing required fields.
