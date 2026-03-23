# MILESTONE-v2.1.1.md

## WeGirl Connector v2.1.1

### 发布日期
2026-03-23

### 新功能

#### 🔍 wegirl_query 工具
新增 Staff 查询工具，支持三种查询方式：
- **id**: staffId 精确匹配
- **name**: name 精确匹配  
- **capability**: 能力模糊匹配

**使用场景:**
发送消息前如果不确定 target 是否存在，必须先调用此工具确认！避免消息发送到不存在的 Staff。

```javascript
// 查询 hr agent
wegirl_query({ by: "id", query: "hr" })

// 按能力查找
wegirl_query({ by: "capability", query: "url" })
```

#### 📝 StaffId 标准化规则
统一 StaffId 处理逻辑：
- **普通 ID 转小写**: `"HR"` → `"hr"`
- **source: 前缀保留**: `"source:ou_xxx"` → `"source:ou_xxx"`

防止因大小写不一致导致的路由问题。

#### ⚠️ 工具描述增强
`wegirl_send` 工具描述添加重要警告：
> "⚠️ 重要：调用前必须确认 target 存在！如不确定，请先调用 wegirl_query 查询可用 Staff 列表。"

### 技术细节

**新增文件:**
- `src/tools.ts` - 添加 `queryStaff()` 和 `normalizeStaffId()` 方法

**修改文件:**
- `src/index.ts` - 注册 `wegirl_query` 工具，更新 `wegirl_send` 描述
- `src/core/send.ts` - 集成 StaffId 标准化

### 兼容性
- 完全向后兼容
- 新增工具不影响现有功能
- 无需配置变更

---

**Full Changelog**: 对比 v2.1.0...v2.1.1
