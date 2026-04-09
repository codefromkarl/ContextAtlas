# Delivery Runbook (2026-04-09)

## 0. 一键完整交付

```bash
pnpm delivery:full
```

## 1. 快速确认交付物是否齐全

```bash
pnpm verify:delivery:artifacts
```

## 2. 完整确认代码与验证状态

```bash
pnpm verify:delivery
```

## 3. 查看机器可消费清单

```bash
pnpm delivery:manifest
```

## 4. 查看人类可读总入口

```bash
pnpm delivery:bundle
```

## 5. 复制交付文本

```bash
pnpm delivery:pr
pnpm delivery:team-update
```

## 6. 合并前最后检查

```bash
pnpm delivery:handoff
pnpm delivery:checklist
```
