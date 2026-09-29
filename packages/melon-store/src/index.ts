/**
 * @melon-ai/store —— 存储。
 *
 * - 根入口：全套**内存**存储（`memoryStorage()`），不带任何依赖，是引擎的默认存储
 * - `@melon-ai/store/sqlite`：SQLite 持久化，需要宿主装 `better-sqlite3`（可选 peer）
 *
 * 两者实现同一组 core 端口，语义由同一组一致性测试守着。
 */
export * from './memory/index.js';
