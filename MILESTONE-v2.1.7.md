# MILESTONE-v2.1.7.md

## WeGirl Connector v2.1.7

### 发布日期
2026-03-30

### 新特性

#### 🖼️ 媒体文件支持（图片识别）
- **媒体文件信息传递**: 在消息正文中添加媒体文件路径信息
- **Agent 图片识别**: 通过 `MediaPath`/`MediaType` 参数让 Agent 能识别图片
- **单文件/多文件支持**: 
  - 单文件: 使用 `MediaPath` 和 `MediaType`
  - 多文件: 使用 `MediaPaths` 和 `MediaTypes` 数组

### 技术细节

**消息格式增强:**
```
[ROUTING_ID:xxx]
[图片: filename.jpg]

[媒体文件]:
- image/jpeg: /path/to/image.jpg
```

**Agent 上下文参数:**
```typescript
// 单文件
{
  MediaPath: "/path/to/image.jpg",
  MediaType: "image/jpeg",
}

// 多文件
{
  MediaPaths: ["/path/to/image1.jpg", "/path/to/image2.png"],
  MediaTypes: ["image/jpeg", "image/png"],
}
```

### 文件变更
- `src/core/sessions-send.ts` - 添加媒体文件处理和 payload 构建

### 兼容性
- 完全向后兼容
- 文本消息不受影响
- Agent 可以选择性处理媒体文件

---

**Full Changelog**: 对比 v2.1.6...v2.1.7
