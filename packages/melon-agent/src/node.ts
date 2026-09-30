import { createHash } from 'node:crypto';
import type { Hasher, Platform } from '@melon-ai/core';
import { defaultPlatform } from './platform.js';
import type { ConsoleLoggerOptions } from './platform.js';

/**
 * `@melon-ai/agent/node` —— Node 专属的平台实现。
 *
 * 根入口的 `defaultPlatform()` 在 Node 上也能用；这里只是把哈希换成原生的 `node:crypto`（快、不必自己算）。
 */
export const nodeHasher: Hasher = {
  sha256: (input) => createHash('sha256').update(input, 'utf8').digest('hex'),
};

export function nodePlatform(opts: ConsoleLoggerOptions = {}): Platform {
  return { ...defaultPlatform(opts), hasher: nodeHasher };
}
