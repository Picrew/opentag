export type FeishuResourceType =
  | "document"
  | "wiki"
  | "folder"
  | "file"
  | "message"
  | "sheet"
  | "bitable";

export type FeishuResourceMetadata = {
  token?: string;
  chatId?: string;
  messageId?: string;
  parentId?: string;
  creatorId?: string;
  modifiedTime?: number;
  mediaType?: string;
  size?: number;
  resourceType?: string;
  [key: string]: unknown;
};

export type FeishuResource = {
  id: string;
  type: FeishuResourceType;
  title?: string;
  text?: string;
  sourceUrl?: string;
  metadata: FeishuResourceMetadata;
};

export type FeishuResourceReference = {
  token: string;
  type: FeishuResourceType;
  sourceUrl?: string;
};

export type FeishuPage<T> = {
  items: T[];
  hasMore: boolean;
  pageToken?: string;
};

export type FeishuDownloadedResource = {
  bytes: Uint8Array;
  fileName?: string;
  mediaType?: string;
};
