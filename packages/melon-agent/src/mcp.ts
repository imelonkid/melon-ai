/**
 * `@melon-ai/agent/mcp` —— 接入 MCP 服务器（Node 宿主）。每个服务器是一个技能来源，工具注册为 `<服务器>.<工具>`。
 *
 * ```ts
 * import { mcp, parseMcpServers } from '@melon-ai/agent/mcp';
 * const gh = mcp({ name: 'github', transport: { kind: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN } } },
 *   { denyRead: [appDataDir] });
 * await agent.configure({ skills: [gh] });
 * gh.status();   // 连接状态、工具列表（含被审查拦下的及原因）、服务器输出 —— 给界面展示
 * ```
 *
 * 服务器是第三方代码：输出不可信（读过的任务之后对外操作要确认）；「只读」标注不采信，所有工具第一次都问，
 * 标了「有破坏性」的每次都问；说明过审查；本机命令跑在沙箱里（密钥、钥匙串、宿主数据不能读写）。
 * `enabled: false`：照样连接、列出工具给用户过目，但不提供给 Agent —— 新加的服务器先这样。
 */
export { mcp, McpServerProvider, parseMcpServers } from '@melon-ai/skills/mcp';
export type { McpServerConfig, McpTransportConfig, McpOptions, McpStatus, McpState, McpToolView } from '@melon-ai/skills/mcp';
