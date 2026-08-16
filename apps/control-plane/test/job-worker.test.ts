import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { scheduleControlPlaneMaintenance } from "../src/modules/jobs/index.js";
import {
  JobHandlerError,
  runJobLoop,
  runOneJob,
} from "../src/modules/jobs/worker.js";

describe("durable job worker", () => {
  it("persists recurring maintenance intent before a worker claims", async () => {
    const enqueue = vi.fn(async () => ({ kind: "created" as const }));
    await scheduleControlPlaneMaintenance({
      queue: { enqueue },
      clock: { now: () => new Date("2026-08-15T12:34:56.789Z") },
    });

    expect(enqueue.mock.calls.map(([command]) => command)).toEqual([
      {
        jobId: "hosted-attempt-reconciliation:2026-08-15T12:34:00.000Z",
        organizationId: null,
        kind: "hosted-attempt-reconciliation",
        payload: { windowStart: "2026-08-15T12:34:00.000Z" },
        maxAttempts: 5,
      },
      {
        jobId: "runner-readiness-retention:2026-08-15T12:34:00.000Z",
        organizationId: null,
        kind: "runner-readiness-retention",
        payload: { windowStart: "2026-08-15T12:34:00.000Z" },
        maxAttempts: 5,
      },
    ]);
  });

  it("settles a supported job through its domain handler", async () => {
    const succeed = vi.fn(async () => ({ kind: "settled" as const }));
    const queue = {
      claim: vi.fn(async () => ({
        kind: "claimed" as const,
        job: {
          jobId: "job_1",
          organizationId: "org_1",
          kind: "retention",
          payload: { before: "2026-01-01" },
          attemptCount: 1,
          maxAttempts: 3,
          leaseOwner: "worker_1",
          leaseToken: "lease_1",
          leaseExpiresAt: "2026-08-15T12:01:00.000Z",
        },
      })),
      succeed,
      fail: vi.fn(),
    };
    const handler = vi.fn(async () => ({ deleted: 4 }));

    const beforeClaim = vi.fn(async () => undefined);
    await expect(runOneJob({
      queue,
      workerId: "worker_1",
      retryDelayMs: 10_000,
      clock: { now: () => new Date("2026-08-15T12:00:00.000Z") },
      handlers: { retention: handler },
      beforeClaim,
    })).resolves.toEqual({ kind: "settled", jobId: "job_1" });
    expect(beforeClaim).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({
      organizationId: "org_1",
      payload: { before: "2026-01-01" },
    });
    expect(succeed).toHaveBeenCalledWith({
      jobId: "job_1",
      leaseToken: "lease_1",
      outcome: { deleted: 4 },
    });
  });

  it("records a closed retry code instead of an exception body", async () => {
    const fail = vi.fn(async () => ({ kind: "retry_scheduled" as const }));
    const queue = {
      claim: vi.fn(async () => ({
        kind: "claimed" as const,
        job: {
          jobId: "job_2",
          organizationId: null,
          kind: "reconcile",
          payload: {},
          attemptCount: 1,
          maxAttempts: 3,
          leaseOwner: "worker_1",
          leaseToken: "lease_2",
          leaseExpiresAt: "2026-08-15T12:01:00.000Z",
        },
      })),
      succeed: vi.fn(),
      fail,
    };

    await runOneJob({
      queue,
      workerId: "worker_1",
      retryDelayMs: 10_000,
      clock: { now: () => new Date("2026-08-15T12:00:00.000Z") },
      handlers: {
        reconcile: async () => {
          throw new JobHandlerError("dependency_unavailable", true);
        },
      },
    });
    expect(fail).toHaveBeenCalledWith({
      jobId: "job_2",
      leaseToken: "lease_2",
      errorCode: "dependency_unavailable",
      retryAt: new Date("2026-08-15T12:00:10.000Z"),
    });
  });

  it("removes each abort listener after an empty poll delay", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const queue = {
      claim: vi.fn(async () => ({ kind: "empty" as const })),
      succeed: vi.fn(),
      fail: vi.fn(),
    };
    const loop = runJobLoop({
      queue,
      workerId: "worker_listener",
      handlers: {},
      retryDelayMs: 10_000,
      pollIntervalMs: 25,
      clock: { now: () => new Date("2026-08-15T12:00:00.000Z") },
      signal: controller.signal,
    });
    for (let index = 0; index < 4; index += 1) {
      await vi.advanceTimersByTimeAsync(25);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    }
    controller.abort();
    await loop;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    vi.useRealTimers();
  });

  it("logs an iteration failure, backs off, and keeps polling", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let claimCount = 0;
    const queue = {
      claim: vi.fn(async () => {
        claimCount += 1;
        if (claimCount === 1) {
          const error = new Error("database-secret must not be logged") as Error & {
            code: string;
          };
          error.name = "DatabaseError\ndatabase-name-secret";
          error.code = "57P01";
          throw error;
        }
        return { kind: "empty" as const };
      }),
      succeed: vi.fn(),
      fail: vi.fn(),
    };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const loop = runJobLoop({
      queue,
      workerId: "worker_resilient",
      handlers: {},
      retryDelayMs: 10_000,
      pollIntervalMs: 25,
      clock: { now: () => new Date("2026-08-15T12:00:00.000Z") },
      signal: controller.signal,
    });
    const observed = loop.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(25);
    expect(queue.claim).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledWith("control_plane_job_iteration_failed", {
      workerId: "worker_resilient",
      errorName: "UnknownError",
      errorCode: "57P01",
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("database-secret");
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
      "database-name-secret",
    );

    controller.abort();
    await observed;
    errorLog.mockRestore();
    vi.useRealTimers();
  });
});
