import { describe, expect, it } from "vitest";
import { fetchLinearProjectBacklog, LINEAR_BACKLOG_MAX_PAGES } from "../src/backlog.js";

type BacklogNode = {
  identifier: string;
  title: string;
  url: string;
  priority?: number | null;
  state: { name: string; type: string };
};

type BacklogPage = {
  project?: { name: string } | null;
  nodes: BacklogNode[];
  hasNextPage?: boolean;
  endCursor?: string | null;
};

type FetchCall = { url: string; body: { query?: unknown; variables?: unknown } };

function fetchStub(input: { calls: FetchCall[]; pages: BacklogPage[] }): typeof fetch {
  let pageIndex = 0;
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    input.calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as FetchCall["body"] });
    const page = input.pages[pageIndex++];
    if (!page) throw new Error(`Unexpected backlog page request ${pageIndex}.`);
    return new Response(
      JSON.stringify({
        data: {
          project: page.project === undefined ? { name: "opentag" } : page.project,
          issues: {
            nodes: page.nodes,
            pageInfo: { hasNextPage: page.hasNextPage ?? false, endCursor: page.endCursor ?? null }
          }
        }
      }),
      { status: 200 }
    );
  }) as typeof fetch;
}

const AMP_153 = {
  identifier: "AMP-153",
  title: "Slack linear command",
  url: "https://linear.app/a/issue/AMP-153",
  priority: 2,
  state: { name: "Todo", type: "unstarted" }
};
const AMP_131 = {
  identifier: "AMP-131",
  title: "OCR fix",
  url: "https://linear.app/a/issue/AMP-131",
  priority: 0,
  state: { name: "In Progress", type: "started" }
};
const AMP_9 = {
  identifier: "AMP-9",
  title: "Old backlog item",
  url: "https://linear.app/a/issue/AMP-9",
  priority: 4,
  state: { name: "Backlog", type: "backlog" }
};

describe("fetchLinearProjectBacklog", () => {
  it("queries unfinished project issues with cursor pagination and no mutation", async () => {
    const calls: FetchCall[] = [];
    await fetchLinearProjectBacklog({
      token: "lin_api_test",
      projectId: "proj_1",
      fetchImpl: fetchStub({ calls, pages: [{ project: { name: "opentag" }, nodes: [] }] })
    });

    expect(calls).toHaveLength(1);
    const query = String(calls[0]!.body.query);
    expect(query).toContain('nin: ["completed", "canceled"]');
    expect(query).toContain("$projectId: ID!");
    expect(query).toContain("$projectKey: String!");
    expect(query).not.toContain("$projectKey: ID!");
    expect(query).toContain("$after: String");
    expect(query).toContain("project(id: $projectKey)");
    expect(query).toContain("priority");
    expect(query).toContain("sort: [{ priority: { order: Descending } }]");
    expect(query).toContain("after: $after");
    expect(query).toContain("pageInfo { hasNextPage endCursor }");
    expect(query).not.toContain("mutation");
    expect(calls[0]!.body.variables).toEqual({ projectId: "proj_1", projectKey: "proj_1", first: 100 });
  });

  it("paginates every unfinished issue before applying the global display sort", async () => {
    const calls: FetchCall[] = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      identifier: `AMP-${index + 1}`,
      title: `Unstarted ${index + 1}`,
      url: `https://linear.app/a/issue/AMP-${index + 1}`,
      priority: 1,
      state: { name: "Todo", type: "unstarted" }
    }));
    const pageTwoStarted = {
      identifier: "AMP-1001",
      title: "Started issue from page two",
      url: "https://linear.app/a/issue/AMP-1001",
      priority: 0,
      state: { name: "In Progress", type: "started" }
    };

    const backlog = await fetchLinearProjectBacklog({
      token: "lin_api_test",
      projectId: "proj_1",
      fetchImpl: fetchStub({
        calls,
        pages: [
          { nodes: firstPage, hasNextPage: true, endCursor: "cursor_1" },
          { nodes: [pageTwoStarted], hasNextPage: false }
        ]
      })
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.variables).toEqual({ projectId: "proj_1", projectKey: "proj_1", first: 100 });
    expect(calls[1]!.body.variables).toEqual({
      projectId: "proj_1",
      projectKey: "proj_1",
      first: 100,
      after: "cursor_1"
    });
    expect(backlog.issues[0]?.identifier).toBe("AMP-1001");
    expect(backlog.fetched).toBe(101);
    expect(backlog.hasMore).toBe(false);
  });

  it("sorts by state type (started, unstarted, backlog) then priority then issue number", async () => {
    const backlog = await fetchLinearProjectBacklog({
      token: "lin_api_test",
      projectId: "proj_1",
      fetchImpl: fetchStub({ calls: [], pages: [{ nodes: [AMP_9, AMP_153, AMP_131] }] })
    });

    expect(backlog.issues.map((issue) => issue.identifier)).toEqual(["AMP-131", "AMP-153", "AMP-9"]);
    expect(backlog.issues[0]).toEqual({
      identifier: "AMP-131",
      title: "OCR fix",
      url: "https://linear.app/a/issue/AMP-131",
      stateName: "In Progress",
      stateType: "started",
      priority: 0
    });
    expect(backlog.fetched).toBe(3);
    expect(backlog.hasMore).toBe(false);
  });

  it("sorts by priority within a single state type: urgent, then high, then medium, then none", async () => {
    const none = {
      identifier: "AMP-4",
      title: "None",
      url: "https://linear.app/a/issue/AMP-4",
      priority: 0,
      state: { name: "Todo", type: "unstarted" }
    };
    const medium = {
      identifier: "AMP-3",
      title: "Medium",
      url: "https://linear.app/a/issue/AMP-3",
      priority: 3,
      state: { name: "Todo", type: "unstarted" }
    };
    const urgent = {
      identifier: "AMP-1",
      title: "Urgent",
      url: "https://linear.app/a/issue/AMP-1",
      priority: 1,
      state: { name: "Todo", type: "unstarted" }
    };
    const high = {
      identifier: "AMP-2",
      title: "High",
      url: "https://linear.app/a/issue/AMP-2",
      priority: 2,
      state: { name: "Todo", type: "unstarted" }
    };

    const backlog = await fetchLinearProjectBacklog({
      token: "lin_api_test",
      projectId: "proj_1",
      fetchImpl: fetchStub({ calls: [], pages: [{ nodes: [none, medium, urgent, high] }] })
    });

    expect(backlog.issues.map((issue) => issue.identifier)).toEqual(["AMP-1", "AMP-2", "AMP-3", "AMP-4"]);
  });

  it("uses the full identifier as a stable tie-breaker when issue numbers match", async () => {
    const sameNumber = [
      { ...AMP_153, identifier: "OTHER-5", priority: 2 },
      { ...AMP_153, identifier: "AMP-5", priority: 2 }
    ];
    const backlog = await fetchLinearProjectBacklog({
      token: "lin_api_test",
      projectId: "proj_1",
      fetchImpl: fetchStub({ calls: [], pages: [{ nodes: sameNumber }] })
    });

    expect(backlog.issues.map((issue) => issue.identifier)).toEqual(["AMP-5", "OTHER-5"]);
  });

  it("maps the project name from the GraphQL response", async () => {
    const backlog = await fetchLinearProjectBacklog({
      token: "lin_api_test",
      projectId: "proj_1",
      fetchImpl: fetchStub({ calls: [], pages: [{ project: { name: "opentag" }, nodes: [] }] })
    });

    expect(backlog.projectName).toBe("opentag");
  });

  it("rejects when the Linear project is missing or inaccessible instead of resolving an empty backlog", async () => {
    const resultPromise = fetchLinearProjectBacklog({
      token: "lin_api_test",
      projectId: "proj_1",
      fetchImpl: fetchStub({ calls: [], pages: [{ project: null, nodes: [] }] })
    });

    await expect(resultPromise).rejects.toThrow(/not found or inaccessible/i);
  });

  it.each([
    ["issues object", { project: { name: "opentag" }, issues: null }],
    ["issue nodes", { project: { name: "opentag" }, issues: { nodes: null, pageInfo: { hasNextPage: false } } }],
    ["pagination metadata", { project: { name: "opentag" }, issues: { nodes: [], pageInfo: null } }]
  ])("rejects a malformed Linear backlog response with missing %s", async (_case, data) => {
    const malformedFetch = (async () =>
      new Response(JSON.stringify({ data }), { status: 200 })) as typeof fetch;

    await expect(
      fetchLinearProjectBacklog({ token: "lin_api_test", projectId: "proj_1", fetchImpl: malformedFetch })
    ).rejects.toThrow(/invalid backlog response/i);
  });

  it("rejects malformed issue nodes with a safe structural error", async () => {
    const malformedFetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            project: { name: "opentag" },
            issues: { nodes: [{ identifier: "AMP-1" }], pageInfo: { hasNextPage: false, endCursor: null } }
          }
        }),
        { status: 200 }
      )) as typeof fetch;

    await expect(
      fetchLinearProjectBacklog({ token: "lin_api_test", projectId: "proj_1", fetchImpl: malformedFetch })
    ).rejects.toThrow(/invalid issue node/i);
  });

  it("maps missing or null priority to 0", async () => {
    const missingPriorityField = {
      identifier: "AMP-5",
      title: "No priority field",
      url: "https://linear.app/a/issue/AMP-5",
      state: { name: "Todo", type: "unstarted" }
    };
    const nullPriority = {
      identifier: "AMP-6",
      title: "Null priority",
      url: "https://linear.app/a/issue/AMP-6",
      priority: null,
      state: { name: "Todo", type: "unstarted" }
    };

    const backlog = await fetchLinearProjectBacklog({
      token: "lin_api_test",
      projectId: "proj_1",
      fetchImpl: fetchStub({ calls: [], pages: [{ nodes: [missingPriorityField, nullPriority] }] })
    });

    expect(backlog.issues.every((issue) => issue.priority === 0)).toBe(true);
  });

  it("rejects hasNextPage without an endCursor rather than returning a partial backlog", async () => {
    const resultPromise = fetchLinearProjectBacklog({
      token: "lin_api_test",
      projectId: "proj_1",
      fetchImpl: fetchStub({ calls: [], pages: [{ nodes: [AMP_153], hasNextPage: true }] })
    });

    await expect(resultPromise).rejects.toThrow(/without an endCursor/i);
  });

  it("rejects repeated cursors rather than looping or returning a partial backlog", async () => {
    const resultPromise = fetchLinearProjectBacklog({
      token: "lin_api_test",
      projectId: "proj_1",
      fetchImpl: fetchStub({
        calls: [],
        pages: [
          { nodes: [AMP_153], hasNextPage: true, endCursor: "cursor_1" },
          { nodes: [AMP_131], hasNextPage: true, endCursor: "cursor_1" }
        ]
      })
    });

    await expect(resultPromise).rejects.toThrow(/repeated endCursor/i);
  });

  it("rejects pagination beyond the explicit page safety limit instead of rendering partial results", async () => {
    const pages = Array.from({ length: LINEAR_BACKLOG_MAX_PAGES }, (_, index) => ({
      nodes: [AMP_153],
      hasNextPage: true,
      endCursor: `cursor_${index + 1}`
    }));
    const resultPromise = fetchLinearProjectBacklog({
      token: "lin_api_test",
      projectId: "proj_1",
      fetchImpl: fetchStub({ calls: [], pages })
    });

    await expect(resultPromise).rejects.toThrow(/page safety limit/i);
  });

  it("propagates GraphQL failures without embedding the token", async () => {
    const failingFetch = (async () =>
      new Response(JSON.stringify({ errors: [{ message: "rate limited" }] }), { status: 429 })) as typeof fetch;

    await expect(
      fetchLinearProjectBacklog({ token: "lin_api_supersecret", projectId: "proj_1", fetchImpl: failingFetch })
    ).rejects.toThrow(/rate limited/);
    await expect(
      fetchLinearProjectBacklog({ token: "lin_api_supersecret", projectId: "proj_1", fetchImpl: failingFetch })
    ).rejects.not.toThrow(/supersecret/);
  });
});
