# @opentag/slack

Slack adapter helpers for OpenTag.

Use this package to normalize Slack `app_mention` events into `OpenTagEvent`
objects, encode or parse Slack source-thread keys, and adapt unified delivery
presentations for Slack.

## Install

```bash
pnpm add @opentag/slack
```

## Exports

- `normalizeSlackAppMention`: converts a Slack app mention into an `OpenTagEvent`.
- `slackThreadKey`: encodes team, channel, and thread timestamp for source-thread delivery.
- `parseSlackThreadKey`: decodes a Slack thread key for `chat.postMessage`.
- `SlackChannelBinding`: Slack compatibility binding contract that maps into the generic channel binding layer.

## Example

```ts
import { normalizeSlackAppMention } from "@opentag/slack";

const event = normalizeSlackAppMention({
  teamId: "T123",
  channelId: "C123",
  userId: "U456",
  text: "<@U_APP> investigate this deploy failure",
  ts: "1710000000.000100",
  eventId: "Ev123",
  eventTime: 1710000000,
  botUserId: "U_APP",
  binding: {
    teamId: "T123",
    channelId: "C123",
    repoProvider: "github",
    owner: "acme",
    repo: "demo"
  }
});

if (event) {
  // Send event to @opentag/client or your own OpenTag-compatible control plane.
}
```

## Stability

Thread key format is part of the source-thread identity used by ingress and the
delivery adapter. A breaking format change must update both sides atomically.
