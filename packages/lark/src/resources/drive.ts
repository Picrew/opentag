import type { FeishuOpenApiClient } from "./client.js";
import type { FeishuDownloadedResource, FeishuPage, FeishuResource, FeishuResourceType } from "./types.js";

type DriveFile = {
  token?: string;
  name?: string;
  type?: string;
  parent_token?: string;
  url?: string;
  created_time?: string;
  modified_time?: string;
  owner_id?: string;
};

type DriveFilePageResponse = {
  files?: DriveFile[];
  has_more?: boolean;
  next_page_token?: string;
};

const DRIVE_TYPES: Readonly<Record<string, FeishuResourceType>> = {
  doc: "document",
  docx: "document",
  folder: "folder",
  file: "file",
  pdf: "file",
  sheet: "sheet",
  bitable: "bitable",
  mindnote: "file",
  slides: "file",
  shortcut: "file"
};

function epochSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function driveResource(file: DriveFile): FeishuResource | undefined {
  if (!file.token || !file.type) return undefined;
  const modifiedTime = epochSeconds(file.modified_time);
  return {
    id: file.token,
    type: DRIVE_TYPES[file.type] ?? "file",
    ...(file.name ? { title: file.name } : {}),
    ...(file.url ? { sourceUrl: file.url } : {}),
    metadata: {
      token: file.token,
      resourceType: file.type,
      ...(file.parent_token ? { parentId: file.parent_token } : {}),
      ...(file.owner_id ? { creatorId: file.owner_id } : {}),
      ...(modifiedTime !== undefined ? { modifiedTime } : {}),
      ...(epochSeconds(file.created_time) !== undefined ? { createdTime: epochSeconds(file.created_time) } : {})
    }
  };
}

export function createFeishuDriveReader(client: FeishuOpenApiClient) {
  async function downloadDriveFile(fileToken: string, options: { maxBytes?: number } = {}): Promise<FeishuDownloadedResource> {
    if (!fileToken.trim()) throw new Error("Feishu Drive file token must not be empty.");
    return client.requestBinary(`/open-apis/drive/v1/medias/${encodeURIComponent(fileToken)}/download`, options);
  }

  async function listDriveFolder(
    folderToken: string,
    options: { pageSize?: number; pageToken?: string } = {}
  ): Promise<FeishuPage<FeishuResource>> {
    if (!folderToken.trim()) throw new Error("Feishu Drive folder token must not be empty.");
    const data = await client.requestJson<DriveFilePageResponse>("/open-apis/drive/v1/files", {
      query: {
        folder_token: folderToken,
        page_size: Math.min(Math.max(options.pageSize ?? 100, 1), 200),
        page_token: options.pageToken
      }
    });
    const items = (data.files ?? []).map(driveResource).filter((item): item is FeishuResource => item !== undefined);
    return {
      items,
      hasMore: data.has_more === true,
      ...(data.next_page_token ? { pageToken: data.next_page_token } : {})
    };
  }

  async function listAll(folderToken: string, pageSize: number, remaining: number): Promise<FeishuResource[]> {
    const items: FeishuResource[] = [];
    let pageToken: string | undefined;
    do {
      const page = await listDriveFolder(folderToken, {
        pageSize: Math.min(pageSize, remaining - items.length),
        ...(pageToken ? { pageToken } : {})
      });
      items.push(...page.items.slice(0, remaining - items.length));
      pageToken = page.hasMore && items.length < remaining ? page.pageToken : undefined;
      if (page.hasMore && !pageToken && items.length < remaining) {
        throw new Error("Feishu Drive pagination reported more data without a page token.");
      }
    } while (pageToken && items.length < remaining);
    return items;
  }

  async function walkDrive(folderToken: string, options: {
    maxDepth?: number;
    maxItems?: number;
    pageSize?: number;
  } = {}): Promise<FeishuResource[]> {
    const maxDepth = Math.max(options.maxDepth ?? 8, 0);
    const maxItems = Math.max(options.maxItems ?? 2_000, 1);
    const pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 200);
    const resources: FeishuResource[] = [];
    const visitedFolders = new Set<string>();
    const queue: Array<{ token: string; depth: number }> = [{ token: folderToken, depth: 0 }];

    while (queue.length > 0 && resources.length < maxItems) {
      const current = queue.shift();
      if (!current || visitedFolders.has(current.token)) continue;
      visitedFolders.add(current.token);
      const children = await listAll(current.token, pageSize, maxItems - resources.length);
      resources.push(...children);
      if (current.depth < maxDepth) {
        for (const child of children) {
          if (child.type === "folder" && !visitedFolders.has(child.id)) {
            queue.push({ token: child.id, depth: current.depth + 1 });
          }
        }
      }
    }
    return resources.slice(0, maxItems);
  }

  return { listDriveFolder, walkDrive, downloadDriveFile };
}

export type FeishuDriveReader = ReturnType<typeof createFeishuDriveReader>;
