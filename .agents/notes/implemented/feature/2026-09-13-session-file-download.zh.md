# Agent Note: Session file download

Status: implemented

[English](2026-09-13-session-file-download.md) | 中文

## 问题

通用文件上传按字节原样持久化，并作为 `FileBlock` 引用进入会话日志，但聊天文件卡只渲染为普通 span，没有下载入口；已有的 `session/attachment` Remote 只服务图片；ZIP 导出虽然携带原始字节，却没有单文件 URL，因此用户无法从拥有该文件的会话中取回完全一致的上传文件。

## 决定

`dsh-session-log-export` 拥有第二个精确 Fetch 路由 `GET`/`HEAD /api/session/file?sessionId=<id>&attachmentId=<opaque-id>`，复用其附件引用收集器、活动会话 flush 与持久化读句柄。会话日志成员关系是唯一权限依据：处理器先 flush 并读取已存储的根日志，找到第一个不透明附件标识命中的文件引用；未知会话或日志从未引用的标识返回 `404`，畸形查询返回 `400`，存储日志不可读时返回不带 Host 路径的 `500`。响应完全由存储引用决定：`Content-Length` 取记录字节长度，媒体类型取窄扩展名映射并以 `application/octet-stream` 兜底，附带 `nosniff` 与 `sandbox` 头；`Content-Disposition` 为附件 disposition，文件名取二次清洗后的叶名，同时携带引号形式与 RFC 5987 形式。`GET` 经 WHATWG 流传输 `attachments.readFileStream`，不收集整个文件，跳过空分块，存储失败时错误结束而不是交付截断字节；`HEAD` 走同一鉴权，只返回头而不返回体。持久聊天文件卡变为指向该 URL 的锚点，由当前会话标识与存储附件标识构造，卡片布局不变；提交回显与准入前预览因尚无持久成员关系而保持普通 span。

## 考虑过的替代方案

- **新建文件下载包。** 已否决：导出包已挂载所需的服务组合（session-query、持久化、附件、活动会话）与引用收集器，新包只会为一个路由复制 flush/读取/扫描路径。
- **新增返回 base64 的 `session/attachmentFile` Typert Remote。** 已否决：验收需要浏览器下载管理器可直接打开的类型化二进制 URL，而不是另一个 JSON 信封；base64 还会把存储本可流式传输的字节再次膨胀。
- **复用 `GET /api/file?path=` 并传入存储 Host 路径。** 已否决：该路由经文件系统提供方服务执行世界路径，而需求禁止接受任意路径或暴露 Host 路径；不透明会话加附件标识把权限留在日志内部。
- **仅信任内容哈希。** 已否决：摘要只能命名，而不能证明谁可读；只有目标会话日志内部的引用才能授权读取，这也让跨会话与陌生附件探测得到同样的 `404`。
- **把路由放在 Session Controller 的 `session/attachment` 旁边。** 已否决：该控制器拥有活动代理 RPC 鉴权，而文件字节需要导出包已有的 flush 加持久化句柄读取；跨界面的全部接口就是一个窄导出查找函数（`findFileAttachmentInArtifact`）。

## 后果

- 聊天文件卡成为真实链接，不新增组件，不改变布局；锚点与 `fileCard` 共用样式，背后是 `nosniff` 安全的字节；未注册路径保持 `404`，二进制 URL 永不变成 SPA HTML。
- 网关只需放行一个新增 `GET`/`HEAD` 路径，与导出共用同一会话身份与 tombstone 检查；单调用白名单、存储与文件系统界面均无变化。
- 媒体类型保持启发式（扩展名映射，octet-stream 兜底），因为 `FileAttachmentRef` 不携带媒体字段；未知类型只下载不渲染。
- 通用文件上传遗留的无界文件保留与附件垃圾回收延期问题保持不变。

## 测试

`packages/session-query/session-log-export/tests/file-download.host.spec.ts` 锁定精确字节、长度、disposition、不实际传输的 HEAD 预检、陌生附件/跨会话/缺失会话的 `404`、畸形查询的 `400`、缺失服务与不可读日志的 `500`、空分块跳过与流中途失败，在基线（路由未注册）上为红。`packages/client/ui-chat/tests/file-card.client.spec.tsx` 锁定锚点 URL 形状、持久锚点渲染与无作用域时的 span 回退，在基线（卡片只有 span）上为红。导出包在其 Host 套件范围内保持语句/分支/函数/行 100%。
