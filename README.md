# 野外无人机编队 · 禁飞标签 OR-Set 因果收敛回放

断网期间多个地面终端各自维护禁飞标签，回传消息乱序、重复。本应用基于
**点集（dot set）+ 因果上下文（版本向量）** 实现 observed-remove（OR-Set）归并，
在浏览器中导入 2–4 个终端的操作脚本与各自收件顺序，逐终端回放并展示每一步的因果依据。

## 语义保证

- **全局唯一点标识**：每次新增产生点 `终端:计数器`（如 `A:3`），同一终端计数器从 1
  严格递增、绝不复用。
- **observed-remove 撤销**：撤销携带「产生时已见上下文」（版本向量），
  **只能清除其产生时已观察到的点**；撤销者未见过的并发新增不会被误删。
- **因果交付**：缺少前序（同原点前缀缺口、撤销上下文中未到达的点）的消息进入
  待处理缓冲，依赖补齐后自动（可连锁）释放。
- **幂等去重**：消息以点标识去重，重复投递（含缓冲期间重复）绝不重复改变状态。
- **收敛**：同一批不可变消息无论投递顺序如何，各终端最终有效标签集合一致。

## 导入校验（失败即定位拒绝并清除旧回放）

- 点标识复用但载荷不同 → `DOT_REUSE_PAYLOAD_MISMATCH`（定位终端与操作下标）
- 终端标识冲突 / 非法
- 撤销缺少上下文、上下文引用不存在的终端或点、上下文包含自身等非法因果上下文
- 收件箱引用未知消息、缺少投递计划、终端数不在 2–4 范围

## 浏览器使用

```bash
npm install
npm run dev        # 开发
npm run build      # 类型检查 + 产物构建到 dist/
npm run preview    # 本地预览构建产物
```

左侧粘贴/编辑 JSON 脚本（可一键载入内置合法/非法示例），「启动回放」后：

- 顶部给出各终端是否收敛及共识有效标签；
- 切换终端标签页，逐步（上一步/下一步）查看：
  - 当前**有效标签**
  - **版本向量**（点云连续前缀的压缩视图）
  - **待处理消息**缓冲
  - **点云**全部已见点（存活/已撤标记）
  - 每一步的**因果依据**：应用新增 / 应用撤销 / 暂存（含尚缺前序）/
    缓冲释放 / 重复投递 / 撤销空操作。

计算（校验与回放）运行在 **Web Worker** 中，不阻塞界面。

### 脚本格式

```json
{
  "terminals": [
    {
      "id": "A",
      "operations": [
    { "type": "add", "tag": "NFZ-ALPHA", "dot": "A:1" },
    { "type": "remove", "tag": "批次1", "dot": "A:2", "context": { "A": 1 } }
      ]
    },
    { "id": "B", "operations": [{ "type": "add", "tag": "NFZ-BRAVO", "dot": "B:1" }] }
  ],
  "deliveries": [
    { "node": "A", "inbox": ["A:1", "B:1", "A:2"] },
    { "node": "B", "inbox": ["A:2", "B:1", "A:1"] }
  ]
}
```

`deliveries[].inbox` 即该终端的收件尝试顺序；同一键出现多次表示网络重复投递。

## 自动验收

```bash
npm run verify
```

依次执行：

1. `vitest run` —— 13 项测试，复核：
   - 并发新增与撤销的收敛结果（未见过的并发新增不被撤销误删）；
   - 乱序暂存与依赖补齐释放（含跨计数器深空洞连锁释放）；
   - 重复投递稳定性（已交付重复、缓冲中重复、重复撤销）；
   - 乱序撤销/新增的墓碑抑制、点云压缩、各类校验拒绝与定位。
2. `tsc --noEmit && vite build` —— 类型检查与生产构建；
3. `node scripts/smoke.mjs` —— 对构建产物启动静态服务器，
   断言 `GET /health` 返回 200 `ok`、首页返回入口 HTML。

## Docker Compose

```bash
# 静态站点（健康路径 /health，宿主机端口可用 HOST_PORT 配置，默认 8080）
HOST_PORT=9090 docker compose up -d web
curl http://localhost:9090/health   # -> ok

# 一次性验收服务：执行测试 + 构建 + 健康冒烟，结束后以退出码报告（0 通过 / 非 0 失败）
docker compose build verify
docker compose up verify            # 容器退出码即验收结果；restart: no，只执行一次
```

- `web`：多阶段构建的 nginx 静态站点，内置 `/health` 健康端点与容器 healthcheck。
- `verify`：基于 builder 阶段运行 `npm run verify`，一次性执行并透传退出码。

## 目录结构

```
src/core/        纯计算核心（无 DOM 依赖，可独立测试）
  types.ts       领域类型与协议
  dotcloud.ts    点云 + 压缩版本向量 + 因果就绪判定
  replay.ts      OR-Set 副本、缓冲释放、全量回放与收敛判定
  validate.ts    导入校验与精确定位
src/worker/      Web Worker 包装
src/ui/          React 单页界面
test/            Vitest 自动验收
scripts/         HTTP 健康冒烟
public/health    健康路径静态文件
```
