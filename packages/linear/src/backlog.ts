import { linearGraphql, type FetchLike } from "./graphql.js";

export const LINEAR_BACKLOG_PAGE_SIZE = 100;
export const LINEAR_BACKLOG_MAX_PAGES = 100;
export const DEFAULT_LINEAR_BACKLOG_TIMEOUT_MS = 10_000;

export type LinearBacklogIssue = {
  identifier: string;
  title: string;
  url: string;
  stateName: string;
  stateType: string;
  priority: number;
};

export type LinearProjectBacklog = {
  issues: LinearBacklogIssue[];
  fetched: number;
  hasMore: boolean;
  projectName: string | null;
};

// The final display order is state-first, then priority, so no server-side
// ordering can make a single page globally correct. Fetch every unfinished
// issue page, then apply the local comparator once to the complete result.
const BACKLOG_QUERY = `query OpenTagProjectBacklog($projectId: ID!, $projectKey: String!, $first: Int!, $after: String) {
  project(id: $projectKey) { name }
  issues(
    filter: {
      project: { id: { eq: $projectId } }
      state: { type: { nin: ["completed", "canceled"] } }
    }
    sort: [{ priority: { order: Descending } }]
    first: $first
    after: $after
  ) {
    nodes { identifier title url priority state { name type } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const STATE_TYPE_ORDER: Record<string, number> = { started: 0, unstarted: 1, backlog: 2, triage: 3 };

type LinearBacklogNode = {
  identifier: string;
  title: string;
  url: string;
  priority?: number | null;
  state: { name: string; type: string };
};

type LinearBacklogPage = {
  project: { name: string };
  issues: {
    nodes: LinearBacklogNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function invalidBacklogResponse(detail: string): Error {
  return new Error(`Linear API returned an invalid backlog response (${detail}).`);
}

function parseBacklogPage(value: unknown): LinearBacklogPage {
  if (!isRecord(value)) throw invalidBacklogResponse("missing data object");
  if (value.project == null) {
    throw new Error("Linear project not found or inaccessible; check the channel-mapped project ID and the token's access.");
  }
  if (!isRecord(value.project) || typeof value.project.name !== "string") {
    throw invalidBacklogResponse("missing project name");
  }
  if (!isRecord(value.issues)) throw invalidBacklogResponse("missing issues object");
  if (!Array.isArray(value.issues.nodes)) throw invalidBacklogResponse("missing issue nodes");
  if (!isRecord(value.issues.pageInfo) || typeof value.issues.pageInfo.hasNextPage !== "boolean") {
    throw invalidBacklogResponse("missing pagination metadata");
  }
  const endCursor = value.issues.pageInfo.endCursor;
  if (endCursor !== undefined && endCursor !== null && typeof endCursor !== "string") {
    throw invalidBacklogResponse("invalid endCursor");
  }

  const nodes = value.issues.nodes.map((node, index): LinearBacklogNode => {
    if (
      !isRecord(node) ||
      typeof node.identifier !== "string" ||
      typeof node.title !== "string" ||
      typeof node.url !== "string" ||
      (node.priority !== undefined && node.priority !== null && typeof node.priority !== "number") ||
      !isRecord(node.state) ||
      typeof node.state.name !== "string" ||
      typeof node.state.type !== "string"
    ) {
      throw invalidBacklogResponse(`invalid issue node at index ${index}`);
    }
    return {
      identifier: node.identifier,
      title: node.title,
      url: node.url,
      ...(node.priority !== undefined ? { priority: node.priority as number | null } : {}),
      state: { name: node.state.name, type: node.state.type }
    };
  });

  return {
    project: { name: value.project.name },
    issues: {
      nodes,
      pageInfo: {
        hasNextPage: value.issues.pageInfo.hasNextPage,
        endCursor: typeof endCursor === "string" ? endCursor : null
      }
    }
  };
}

function issueNumber(identifier: string): number {
  const value = Number(identifier.split("-")[1]);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function compareIdentifier(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Linear priority semantics: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
// Rank "none" after every set priority so unprioritized issues sort last
// within their state type.
function priorityRank(priority: number): number {
  return priority === 0 ? 5 : priority;
}

function remainingTimeoutMs(deadlineMs: number): number {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    throw new Error("Linear backlog query timed out before all pages were fetched.");
  }
  return remaining;
}

export async function fetchLinearProjectBacklog(input: {
  token: string;
  projectId: string;
  graphqlUrl?: string;
  fetchImpl: FetchLike;
  timeoutMs?: number;
}): Promise<LinearProjectBacklog> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_LINEAR_BACKLOG_TIMEOUT_MS;
  const deadlineMs = Date.now() + timeoutMs;
  const nodes: LinearBacklogNode[] = [];
  const seenCursors = new Set<string>();
  let after: string | undefined;
  let projectName: string | null = null;

  for (let pageNumber = 1; pageNumber <= LINEAR_BACKLOG_MAX_PAGES; pageNumber += 1) {
    const rawData = await linearGraphql<unknown>({
      token: input.token,
      ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
      query: BACKLOG_QUERY,
      variables: {
        projectId: input.projectId,
        projectKey: input.projectId,
        first: LINEAR_BACKLOG_PAGE_SIZE,
        ...(after ? { after } : {})
      },
      fetchImpl: input.fetchImpl,
      timeoutMs: remainingTimeoutMs(deadlineMs)
    });
    const data = parseBacklogPage(rawData);
    projectName ??= data.project.name;
    nodes.push(...data.issues.nodes);

    if (!data.issues.pageInfo.hasNextPage) break;
    const endCursor = data.issues.pageInfo.endCursor?.trim();
    if (!endCursor) {
      throw new Error("Linear backlog pagination returned hasNextPage without an endCursor.");
    }
    if (seenCursors.has(endCursor)) {
      throw new Error("Linear backlog pagination returned a repeated endCursor.");
    }
    if (pageNumber === LINEAR_BACKLOG_MAX_PAGES) {
      throw new Error(`Linear backlog pagination exceeded the ${LINEAR_BACKLOG_MAX_PAGES}-page safety limit.`);
    }
    seenCursors.add(endCursor);
    after = endCursor;
  }

  const issues = nodes
    .map((node) => ({
      identifier: node.identifier,
      title: node.title,
      url: node.url,
      stateName: node.state.name,
      stateType: node.state.type,
      priority: node.priority ?? 0
    }))
    .sort(
      (a, b) =>
        (STATE_TYPE_ORDER[a.stateType] ?? 9) - (STATE_TYPE_ORDER[b.stateType] ?? 9) ||
        priorityRank(a.priority) - priorityRank(b.priority) ||
        issueNumber(a.identifier) - issueNumber(b.identifier) ||
        compareIdentifier(a.identifier, b.identifier)
    );
  return {
    issues,
    fetched: issues.length,
    hasMore: false,
    projectName
  };
}
