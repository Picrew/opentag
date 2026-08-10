import type { OpenTagEvent, OpenTagRun, OpenTagRunResult } from "@opentag/core";
import { buildPullRequestBody, createPullRequestViaFetch, type FetchLike } from "@opentag/github";
import {
  branchNameForRun,
  commitChangedFiles,
  nodeCommandRunner,
  pushBranch,
  type CommandRunner,
  type ExecutorCapabilityContract
} from "@opentag/runner";
import {
  canonicalRepositoryIdentity,
  type RepositoryBindingConfig,
} from "./config.js";

export type PullRequestOptions = {
  githubToken?: string;
  preparePullRequestBranch?: boolean;
  allowAutoCreatePullRequest?: boolean;
  commandRunner?: CommandRunner;
  fetchImpl?: FetchLike;
};

function hasPermission(event: OpenTagEvent, scope: string): boolean {
  return event.permissions.some((permission) => permission.scope === scope);
}

function isGitHubRepositoryTarget(input: { event: OpenTagEvent; binding: RepositoryBindingConfig }): boolean {
  const repoProvider = input.event.metadata["repoProvider"];
  return input.binding.provider.toLowerCase() === "github"
    && (repoProvider == null
      || (typeof repoProvider === "string" && repoProvider.toLowerCase() === "github"));
}

function repositoryTargetMatchesBinding(input: { event: OpenTagEvent; binding: RepositoryBindingConfig }): boolean {
  const owner = input.event.metadata["owner"];
  const repo = input.event.metadata["repo"];
  if (typeof owner !== "string" || typeof repo !== "string") return false;
  const provider = input.event.metadata["repoProvider"];
  const targetIdentity = canonicalRepositoryIdentity({
    provider: typeof provider === "string" ? provider : input.binding.provider,
    owner,
    repo,
  });
  const bindingIdentity = canonicalRepositoryIdentity(input.binding);
  return targetIdentity.provider === bindingIdentity.provider
    && targetIdentity.owner === bindingIdentity.owner
    && targetIdentity.repo === bindingIdentity.repo;
}

type CreatePullRequestIntent = {
  head: string;
  base?: string;
  title?: string;
  body?: string;
};

function createPullRequestIntent(result: OpenTagRunResult): CreatePullRequestIntent | null {
  for (const snapshot of result.suggestedChanges ?? []) {
    for (const intent of snapshot.intents) {
      if (intent.domain !== "pull_request" || intent.action !== "create_pull_request") continue;
      const head = intent.params?.["head"];
      if (typeof head !== "string" || head.length === 0) continue;
      const base = intent.params?.["base"];
      const title = intent.params?.["title"];
      const body = intent.params?.["body"];
      return {
        head,
        ...(typeof base === "string" && base.length > 0 ? { base } : {}),
        ...(typeof title === "string" && title.length > 0 ? { title } : {}),
        ...(typeof body === "string" && body.length > 0 ? { body } : {})
      };
    }
  }
  return null;
}

export async function maybeCreatePullRequest(input: {
  run: OpenTagRun;
  executorCapability?: Pick<ExecutorCapabilityContract, "sourceControl">;
  event: OpenTagEvent;
  binding: RepositoryBindingConfig;
  result: OpenTagRunResult;
  options: PullRequestOptions;
  assertExecutionCurrent?: () => Promise<boolean>;
}): Promise<OpenTagRunResult> {
  if (!input.options.allowAutoCreatePullRequest && !input.options.preparePullRequestBranch) return input.result;
  if (!isGitHubRepositoryTarget({ event: input.event, binding: input.binding })) return input.result;
  if (!repositoryTargetMatchesBinding({ event: input.event, binding: input.binding })) return input.result;
  if (!hasPermission(input.event, "pr:create")) return input.result;
  const changedFiles = input.result.changedFiles ?? [];
  if (changedFiles.length === 0) return input.result;
  const owner = input.binding.owner;
  const repo = input.binding.repo;

  const intent = createPullRequestIntent(input.result);
  const branchName = intent?.head ?? branchNameForRun(input.run.id);
  const runner = input.options.commandRunner ?? nodeCommandRunner;
  const assertExecutionCurrent = async () => {
    if (
      input.assertExecutionCurrent
      && !(await input.assertExecutionCurrent())
    ) {
      throw new Error("execution_authority_expired");
    }
  };
  if (input.executorCapability?.sourceControl !== "self_committing") {
    await assertExecutionCurrent();
    await commitChangedFiles({
      runner,
      workspacePath: input.binding.checkoutPath,
      files: changedFiles,
      message: `OpenTag run ${input.run.id}`
    });
  }
  await assertExecutionCurrent();
  await pushBranch({
    runner,
    workspacePath: input.binding.checkoutPath,
    remote: input.binding.pushRemote ?? "origin",
    branchName
  });

  if (!input.options.allowAutoCreatePullRequest) {
    return input.result;
  }
  if (!input.options.githubToken) return input.result;

  await assertExecutionCurrent();
  const pullRequestUrl = await createPullRequestViaFetch(
    {
      token: input.options.githubToken,
      owner,
      repo,
      title: intent?.title ?? `OpenTag run ${input.run.id}`,
      body: intent?.body ?? buildPullRequestBody(input.result),
      head: branchName,
      base: intent?.base ?? input.binding.baseBranch ?? "main"
    },
    input.options.fetchImpl
  );

  return {
    ...input.result,
    createdPullRequestUrl: pullRequestUrl,
    artifacts: [...(input.result.artifacts ?? []), { kind: "pull_request", title: "Pull request", uri: pullRequestUrl }],
    nextAction: {
      summary: `Review pull request: ${pullRequestUrl}`,
      hint: {
        kind: "request_review",
        metadata: { pullRequestUrl }
      }
    }
  };
}
