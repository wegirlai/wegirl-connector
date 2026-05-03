# MILESTONE v1.1.0

## 日期
2026-05-03

## 变更摘要
移除 `sessions-send.ts` 中的硬编码模型配置，允许 OpenClaw 使用实例配置的默认模型。

## 详细变更

### `src/core/sessions-send.ts`
- 删除进程消息中的硬编码 `Model: 'kimi-coding/k2p5'` 字段
- 消息处理现在遵循 OpenClaw 实例的默认模型配置，不再强制覆盖为特定模型
- 提升灵活性：不同实例可根据需求配置不同模型，无需修改插件代码

## 影响范围
- **Agent 回复流程**：所有通过 `processMessage` 处理的 A2A / A2H / H2A 消息
- **模型选择**：由 OpenClaw Gateway 根据实例配置决定，而非插件强制指定
- **向后兼容**：完全兼容，无破坏性变更

## 版本同步
- `package.json`: `1.0.9` → `1.1.0`
- `openclaw.plugin.json`: `1.0.0` → `1.1.0`

## 备注
此变更解决了插件与实例模型配置冲突的问题。此前插件强制使用 `kimi-coding/k2p5`，导致即使用户在 OpenClaw 配置中指定了其他模型，实际调用仍被覆盖。
