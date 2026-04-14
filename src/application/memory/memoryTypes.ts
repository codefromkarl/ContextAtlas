/**
 * Memory Application Layer 共享类型
 *
 * MCP adapter 和 CLI adapter 通过这些类型与 application 层交互。
 * Zod schema 仅留在 MCP adapter 层，application 层接收已验证的 plain input。
 */

// ===========================================
// Response 类型
// ===========================================

export type ResponseFormat = 'text' | 'json';

/**
 * Memory tool 统一响应类型
 *
 * 与 MCP protocol 的 `{ content: Array<{ type: 'text'; text: string }> }` 兼容，
 * 但不依赖任何 MCP/Zod 定义。
 */
export type MemoryToolResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};
