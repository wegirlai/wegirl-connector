# MILESTONE-v1.0.7.md

## v1.0.7 (2026-04-20)

### 新增功能

**1. JSON Schema 响应格式支持** (`sessions-send.ts`)
- ✅ 新增 `responseSchema` 元数据支持
- ✅ 自动注入 `[JSON_MODE]` 提示到消息中
- ✅ Agent 可返回结构化 JSON 响应
- ✅ 使用方式：在 `metadata.responseSchema` 中传入 JSON Schema

**2. NPC 类型支持** (`list_staffs`)
- ✅ 支持 `type: 'npc'` 的 Staff 类型
- ✅ 花名册显示新增 🎭 NPC 分组
- ✅ 按实例分组展示 NPC 成员
- ✅ 统计包含 NPC 数量

**3. HR 结果格式化** (`formatResultForReply`)
- ✅ 将 JSON 结果转换为易读的文本格式
- ✅ `list_staffs` 输出美化：
  - 按实例分组展示
  - 支持 Agents (🤖)、Humans (👤)、NPCs (🎭)
  - 在线状态指示：🟢 在线 / ⚪ 离线
  - 底部统计：共 N 位成员（🤖 X / 👤 Y / 🎭 Z）

### 技术改进

| 文件 | 改动 |
|------|------|
| `src/core/sessions-send.ts` | +20 行：添加 `schemaToCompactPrompt` 函数，处理 `responseSchema` |
| `src/index.ts` | +39/-5 行：NPC 支持、结果格式化、debug 日志 |

### 使用示例

**JSON Schema 响应：**
```javascript
wegirl_send({
  target: 'analyst',
  message: '分析这份数据',
  metadata: {
    responseSchema: {
      summary: 'string',
      keyPoints: ['string'],
      score: 'number'
    }
  }
});
```

**花名册显示：**
```
📋 团队花名册

wegirl001 实例：
🤖 scout - URL发现 🟢
🤖 harvester - 内容抓取 🟢

wegirl002 实例：
👤 tiger - 老板 🟢
🎭 narrator - 旁白 ⚪

共 4 位成员（🤖 2 / 👤 1 / 🎭 1）
```

### 文件变更

- `src/core/sessions-send.ts` - JSON_MODE 支持
- `src/index.ts` - NPC 类型、格式化输出
- 8 个编译后的 dist 文件同步更新

---

**发布日期**: 2026-04-20  
**版本号**: v1.0.7  
**Commit**: 待推送
