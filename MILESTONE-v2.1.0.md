# MILESTONE-v2.1.0.md

## WeGirl Connector v2.1.0 里程碑

**发布日期**: 2026-03-22

---

## 新增功能

### 1. hr_manage 工具参数改进
- **source 参数**: 将 `from` 参数重命名为 `source`，与其他工具保持一致
- **source: 前缀保留**: 当传入的 source 包含 `source:` 或 `source：` 前缀时，原样保留传递给后续处理

### 2. 入职解析优化
- **isOnboardFormat 缓存**: 使用变量缓存结果，避免函数重复调用
- **单行格式支持**: 改进 `parseOnboardData` 函数，支持单行格式的入职信息
  - 示例: `工号：tiger 姓名：Tiger 电话：138000138000 角色：ceo 能力：管理`
- **中英文冒号支持**: 同时支持 `:` 和 `：` 作为字段分隔符

### 3. 代码质量改进
- 移除不必要的 `continue` 语句
- 优化正则表达式匹配逻辑
- 统一字段解析方式

---

## 技术细节

### 关键修改文件

#### `src/index.ts`
- `hr_manage` 工具参数定义：`from` → `source`
- `create_staff` case：保持 source 参数原样传入

#### `src/hr-message-handler.ts`
- `handlePrivateMessage`: 缓存 `isOnboardFormat` 结果
- `parseOnboardData`: 重写解析逻辑，合并多行为单行处理
- 优化各字段的正则表达式匹配

#### `src/channel.ts`
- 相关类型定义更新

---

## API 变更

### hr_manage 工具

#### create_staff 动作
```javascript
hr_manage({
  action: "create_staff",
  source: "source：ou_xxx",  // 保持原样传入，包含前缀
  message: "我要入职",
  target: "hr",
  chatType: "direct"
})
```

**重要**: source 参数必须保持原样，不要去除 `source:` 或 `source：` 前缀。

---

## 入职信息格式

### 支持的格式

#### 多行格式
```
工号：tiger
姓名：Tiger
电话：138000138000
角色：ceo
能力：管理
```

#### 单行格式
```
工号：tiger 姓名：Tiger 电话：138000138000 角色：ceo 能力：管理
```

#### 英文冒号格式
```
工号: tiger
姓名: Tiger
...
```

---

## 测试建议

1. **source 前缀保留**: 验证 `source：ou_xxx` 格式正确传递
2. **单行解析**: 测试单行格式的入职信息
3. **多行解析**: 测试传统多行格式
4. **中英文冒号**: 测试两种冒号都能正确解析

---

## 相关提交

- `ef84ef0`: feat: hr_manage improvements and source prefix handling

---

## 兼容性说明

- 与 wegirl-service v0.3.0+ 完全兼容
- source 前缀处理需要服务端配合支持

---

## 下一步计划

- [ ] 群聊 @ mention 支持
- [ ] 工作流状态跟踪
- [ ] 消息重试机制
- [ ] 更完善的错误处理
