# v1.0.9 (2026-04-30)

## RAG 工具修复

**Bug 描述**: `rag` 工具调用 sitemap_api 后，即使 API 返回了匹配结果，工具仍报告"未找到相关知识库内容"。

**根因**: sitemap_api 返回的成功标志字段是 `code: 200`，而 `rag` 工具检查的是 `data.success`（该字段不存在，值为 `undefined`），导致条件 `!data.success` 恒为 `true`，误判为空结果。

**修复**:
- ✅ 将判断条件从 `!data.success || !data.data?.results?.length` 改为 `data.code !== 200 || !data.data?.results?.length`
- ✅ 文件位置: `src/index.ts`（RAG execute 函数）

## 验证

修复前:
```
query: "CNC machining" → total: 5, results: [...5条]
rag tool 输出: "未找到相关知识库内容。"  ❌
```

修复后:
```
rag tool 输出: 📚 知识检索结果（5 条 CNC 相关内容） ✅
```

## 关联文件

- `src/index.ts` — RAG execute 函数
- `src/config.ts` — `getRagApiConfig()` 提供 API 地址 `http://10.8.0.61:4001`
