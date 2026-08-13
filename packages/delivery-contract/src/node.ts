import { createHash } from 'node:crypto';

import type { DigestProvider } from './digest.js';

export const nodeSha256DigestProvider: DigestProvider = {
  sha256(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  },
};
