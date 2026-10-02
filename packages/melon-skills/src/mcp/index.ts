/**
 * `@melon-ai/skills/mcp` —— 接入 MCP 服务器（Model Context Protocol）：每个服务器是一个技能来源。
 *
 * 单独一个子路径：要 Node（起本机进程）和官方 SDK，技能包的根入口保持与运行时无关。
 * 服务器是第三方代码：输出不可信、「只读」标注不采信、说明过审查、本机命令跑在沙箱里。见 provider.ts。
 */
export { mcp, McpServerProvider, parseMcpServers, renderContent, slug as mcpSlug } from './provider.js';
export type { McpServerConfig, McpTransportConfig, McpOptions, McpStatus, McpState, McpToolView } from './provider.js';
