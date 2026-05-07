# Changelog

## v1.2.0 — replyContentType 协议升级

**发布日期**: 2026-05-08

### ✨ 新增

- **`replyContentType` 字段** — 消息顶层新增 `replyContentType` 字段，取值 `text` | `md` | `json`，标记回复内容格式类型
- **`buildMessage` 改造** — `MessageBuilderOptions` 新增 `replyContentType` 参数，`buildMessage` 将其写入消息顶层，不再通过事后 `(msg as any).replyContentType` 追加
- **wegirl:forward 默认值** — `wegirl:forward` 消息 `replyContentType` 固定为 `'text'`，回复消息跟随传入值
- **JSON 模式注入** — `replyContentType === 'json'` 时自动注入 JSON_MODE prompt；若无 `responseSchema`，fallback 到 `{message: ""}`

### 🔄 变更

- `handleAgentReply` 中所有 Redis 消息（同步响应、群聊媒体/文本、单 agent 媒体/文本、错误回复、world stream）统一通过 `buildMessage({ replyContentType })` 构造
- `finalizeInboundContext` 的 `Metadata.expectJson` 改为由 `replyContentType === 'json'` 控制

### 🛠 配套

- `wegirl-service` 数据库 `service_messages` 表新增 `reply_content_type VARCHAR(8)` 字段（`md`/`json`），默认 `'md'`
- `event_handler.py` 三个入库点均传入 `replyContentType`

---

## v1.1.1 — world stream expectJson marker

**发布日期**: 2026-05-07

### 🐛 修复

- `service_messages.id` 列从 `VARCHAR(64)` 扩到 `VARCHAR(255)`，解决 `Data too long` 报错
- `handleAgentReply` 中 `from=world` 的消息发送到 `wegirl:stream:world` 时，metadata 添加 `expectJson` 标记

---
