import * as controlProtocol from "@opentag/control-protocol";
import * as core from "@opentag/core";
import { describe, expect, it } from "vitest";

describe("Control V1 public package seam", () => {
  it("keeps the Core compatibility exports identity-equal to the focused package", () => {
    expect(core.RelayCapabilitiesResponseV1Schema).toBe(
      controlProtocol.RelayCapabilitiesResponseV1Schema,
    );
    expect(core.RunnerRegistrationRequestV1Schema).toBe(
      controlProtocol.RunnerRegistrationRequestV1Schema,
    );
    expect(core.HostedClaimV1Schema).toBe(controlProtocol.HostedClaimV1Schema);
    expect(core.computeHostedLifecycleRequestDigestV1).toBe(
      controlProtocol.computeHostedLifecycleRequestDigestV1,
    );
    expect(core.CompletionGateResultStateSchema).toBe(
      controlProtocol.CompletionGateResultStateSchema,
    );
    expect(core.CompletionReasonCodeSchema).toBe(
      controlProtocol.CompletionReasonCodeSchema,
    );
    expect(core.COMPLETION_REASON_ALLOWED_GATE_STATES).toBe(
      controlProtocol.COMPLETION_REASON_ALLOWED_GATE_STATES,
    );
    expect(core.reduceCompletionGateStates).toBe(
      controlProtocol.reduceCompletionGateStates,
    );
  });

  it("accepts the existing capability response through both public paths", () => {
    const response = {
      schemaVersion: 1,
      protocolVersion: "1.0",
      registryVersion: "opentag.control.capabilities/v1",
      capabilities: ["relay.readiness.v1"],
      minimumClient: {
        schemaVersion: 1,
        protocolVersion: "1.0",
      },
      deployment: {
        environment: "local",
        releaseSha: "local",
      },
    } as const;

    expect(controlProtocol.RelayCapabilitiesResponseV1Schema.parse(response)).toEqual(response);
    expect(core.RelayCapabilitiesResponseV1Schema.parse(response)).toEqual(response);
  });
});
