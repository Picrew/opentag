type ClaimedJob = {
  jobId: string;
  organizationId: string | null;
  kind: string;
  payload: unknown;
  attemptCount: number;
  maxAttempts: number;
  leaseOwner: string;
  leaseToken: string;
  leaseExpiresAt: string;
};

type WorkerQueue = {
  claim(workerId: string): Promise<
    | { kind: "claimed"; job: ClaimedJob }
    | { kind: "empty" }
  >;
  succeed(command: {
    jobId: string;
    leaseToken: string;
    outcome: unknown;
  }): Promise<{ kind: string }>;
  fail(command: {
    jobId: string;
    leaseToken: string;
    errorCode: string;
    retryAt?: Date;
  }): Promise<{ kind: string }>;
};

type JobHandler = (input: {
  organizationId: string | null;
  payload: unknown;
}) => Promise<unknown>;

export class JobHandlerError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "JobHandlerError";
  }
}

export async function runOneJob(input: {
  queue: WorkerQueue;
  workerId: string;
  handlers: Readonly<Record<string, JobHandler>>;
  retryDelayMs: number;
  clock: { now(): Date };
  beforeClaim?: () => Promise<void>;
}) {
  await input.beforeClaim?.();
  const claim = await input.queue.claim(input.workerId);
  if (claim.kind === "empty") return { kind: "empty" } as const;
  const handler = input.handlers[claim.job.kind];
  if (!handler) {
    await input.queue.fail({
      jobId: claim.job.jobId,
      leaseToken: claim.job.leaseToken,
      errorCode: "unsupported_job_kind",
    });
    return { kind: "failed", jobId: claim.job.jobId } as const;
  }
  try {
    const outcome = await handler({
      organizationId: claim.job.organizationId,
      payload: claim.job.payload,
    });
    const settlement = await input.queue.succeed({
      jobId: claim.job.jobId,
      leaseToken: claim.job.leaseToken,
      outcome,
    });
    return settlement.kind === "settled" || settlement.kind === "replayed"
      ? { kind: "settled", jobId: claim.job.jobId } as const
      : { kind: "stale_lease", jobId: claim.job.jobId } as const;
  } catch (error) {
    const handlerError = error instanceof JobHandlerError
      ? error
      : new JobHandlerError("job_handler_failed", true);
    const failure = await input.queue.fail({
      jobId: claim.job.jobId,
      leaseToken: claim.job.leaseToken,
      errorCode: handlerError.code,
      ...(handlerError.retryable
        ? { retryAt: new Date(input.clock.now().getTime() + input.retryDelayMs) }
        : {}),
    });
    return {
      kind: failure.kind === "retry_scheduled" ? "retry_scheduled" : "failed",
      jobId: claim.job.jobId,
    } as const;
  }
}

export async function runJobLoop(input: {
  queue: WorkerQueue;
  workerId: string;
  handlers: Readonly<Record<string, JobHandler>>;
  retryDelayMs: number;
  pollIntervalMs: number;
  clock: { now(): Date };
  signal: AbortSignal;
}): Promise<void> {
  while (!input.signal.aborted) {
    const outcome = await runOneJob(input);
    if (outcome.kind !== "empty") continue;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, input.pollIntervalMs);
      input.signal.addEventListener("abort", finish, { once: true });
      if (input.signal.aborted) finish();
    });
  }
}
