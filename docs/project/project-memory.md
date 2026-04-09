# Project Memory - 功能记忆层

## 概述

Project Memory 是 ContextAtlas 的轻量级记忆层，提供快速的功能记忆查询和架构决策记录，无需向量检索即可在 50ms 内返回结果。

## 存储结构（单 SQLite）

```
~/.contextatlas/memory-hub.db

tables:
- projects                # 项目注册表
- feature_memories        # 模块记忆（单项目 + 跨项目）
- decision_records        # 架构决策
- shared_index            # 搜索加速索引
- project_memory_meta     # catalog / global / profile 等项目级元数据
```

说明：
- `.project-memory/` 仅作为历史兼容导入源，不再作为主存储。
- `.omc/project-memory.json` 可作为项目档案导入源，导入后统一写入 SQLite 的 `global:profile / global:conventions / global:cross-cutting`。
- 首次访问项目记忆时会自动注册项目并导入旧 JSON（如存在）。

## 核心模块

### 1. MemoryFinder (`src/memory/MemoryFinder.ts`)

快速查找功能记忆，使用关键词匹配 + 标签匹配：

```typescript
const finder = new MemoryFinder(projectRoot);
const results = await finder.find('auth', { limit: 10, minScore: 1 });
```

### 2. MemoryStore (`src/memory/MemoryStore.ts`)

提供 CRUD 操作：

```typescript
const store = new MemoryStore(projectRoot);
await store.saveFeature(memory);
await store.saveDecision(decision);
await store.saveProfile(profile);
```

## MCP 工具

### find_memory

快速查找功能记忆：

```json
{
  "name": "find_memory",
  "arguments": {
    "query": "auth",
    "limit": 10,
    "minScore": 1
  }
}
```

### record_memory

记录功能记忆：

```json
{
  "name": "record_memory",
  "arguments": {
    "name": "Authentication Module",
    "responsibility": "用户认证、JWT 签发、权限验证",
    "dir": "src/auth/",
    "files": ["auth.service.ts", "auth.controller.ts"],
    "exports": ["AuthService", "AuthGuard"],
    "imports": ["@/utils/crypto"],
    "external": ["@nestjs/jwt", "bcrypt"],
    "dataFlow": "用户输入 → Controller → Service → JWT 签发 → 返回",
    "keyPatterns": ["Strategy 模式", "Guard 拦截器"]
  }
}
```

### record_decision

记录架构决策：

```json
{
  "name": "record_decision",
  "arguments": {
    "id": "2026-03-27-architecture",
    "title": "选择 NestJS 而非 Express",
    "context": "需要构建可扩展的 API 服务",
    "decision": "使用 NestJS 框架",
    "rationale": "NestJS 提供依赖注入和模块化，适合团队协作",
    "alternatives": [
      {
        "name": "Express",
        "pros": ["轻量", "生态大"],
        "cons": ["缺少架构约束"]
      }
    ],
    "consequences": ["需要学习曲线", "启动时间稍长", "架构更清晰"]
  }
}
```

### get_project_profile

获取项目档案。

## CLI 命令

```bash
# 查找功能记忆
contextatlas memory:find "auth"

# 记录功能记忆
contextatlas memory:record "Auth Module" \
  --desc "用户认证和 JWT 签发" \
  --dir "src/auth/" \
  --files "auth.service.ts,auth.controller.ts" \
  --exports "AuthService,AuthGuard" \
  --imports "@/utils/crypto" \
  --external "@nestjs/jwt,bcrypt"

# 列出所有功能记忆
contextatlas memory:list

# 记录架构决策
contextatlas decision:record "2026-03-27-architecture" \
  --title "选择 NestJS 而非 Express" \
  --context "需要构建可扩展的 API 服务" \
  --decision "使用 NestJS 框架" \
  --rationale "NestJS 提供依赖注入和模块化" \
  --consequences "学习曲线，启动时间稍长，架构更清晰"

# 列出所有架构决策
contextatlas decision:list

# 显示项目档案
contextatlas profile:show
```

## 使用场景

### 90% 场景：使用 find_memory

```
用户：认证模块在哪里？
AI: 使用 find_memory("auth") → 50ms 返回模块记忆
     - 位置：src/auth/
     - 职责：用户认证、JWT 签发
     - 导出：AuthService, AuthGuard
```

### 10% 场景：使用 search_code

```
用户：JWT 签发的具体实现逻辑？
AI: 先 find_memory("auth") 定位模块
     再 search_code("JWT token generation") 查看代码细节
```

## 工作流

### Phase 1: 项目初始化（一次性）

```bash
contextatlas index .  # 扫描代码库
# 生成 profile.json
```

### Phase 2: 记忆构建

**方式 A: 主动分析（开发新功能时）**
```bash
contextatlas memory:record "NewModule" --desc "..." --dir "..."
```

**方式 B: 被动提取（对话结束时）**
```bash
# 使用 MCP record_memory 或 record_decision 工具
```

### Phase 3: 记忆查找（开发时）

```bash
# MCP: find_memory(query="认证")
# 在 memory-hub.db 中按项目过滤并检索
# 50ms 返回结果
```

### Phase 4: 代码检索（仅当需要看具体实现）

```bash
# MCP: search_code(query="JWT 签发逻辑")
# 委托给 ContextAtlas 向量检索
```

## 数据格式

### FeatureMemory

```json
{
  "name": "Authentication Module",
  "location": {
    "dir": "src/auth/",
    "files": ["auth.service.ts", "auth.controller.ts", "jwt.strategy.ts"]
  },
  "responsibility": "用户认证、JWT 签发、权限验证",
  "api": {
    "exports": ["AuthService", "AuthGuard", "JwtStrategy"],
    "endpoints": [
      {
        "method": "POST",
        "path": "/auth/login",
        "handler": "AuthController.login"
      }
    ]
  },
  "dependencies": {
    "imports": ["@/utils/crypto", "@/config/auth.config"],
    "external": ["@nestjs/jwt", "bcrypt", "passport"]
  },
  "dataFlow": "用户输入 → Controller → Service (bcrypt 验证) → JWT 签发 → 返回",
  "keyPatterns": ["Strategy 模式", "Guard 拦截器", "Decorator 权限"],
  "lastUpdated": "2026-03-27T10:00:00Z",
  "relatedDecisions": ["2026-03-27-architecture"]
}
```

### DecisionRecord

```json
{
  "id": "2026-03-27-architecture",
  "date": "2026-03-27",
  "title": "选择 NestJS 而非 Express",
  "context": "需要构建可扩展的 API 服务",
  "decision": "使用 NestJS 框架",
  "alternatives": [
    {
      "name": "Express",
      "pros": ["轻量", "生态大"],
      "cons": ["缺少架构约束"]
    }
  ],
  "rationale": "NestJS 提供依赖注入和模块化，适合团队协作",
  "consequences": ["需要学习曲线", "启动时间稍长", "架构更清晰"],
  "status": "accepted"
}
```

## 对比优势

| 场景 | 无记忆系统 | 新系统 |
|------|-----------|--------|
| 问：认证模块在哪？ | 扫描全项目 → 2000 tokens → 30s | find_memory("auth") → 50ms → 返回 JSON |
| 问：为什么用 JWT？ | AI 无法回答（无历史） | 查 decisions/ → 返回架构决策 |
| 问：如何添加新 endpoint？ | AI 分析代码 → 可能不符合约定 | 查 profile → 直接给出符合约定的模板 |
| 开发新功能 | 需要重新理解项目 | 已有模块职责清晰，直接复用 |
