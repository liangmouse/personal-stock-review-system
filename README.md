# 个人交易流水

单用户股票交易日志。登录后可查看订单和事件、筛选流水、核对订单生命周期并编写执行复盘。服务端提供订单 API，以及记录订单和复盘的远程 MCP 工具。

项目源码公开托管在下列 GitHub 仓库。应用密钥保存在服务端环境变量中，交易数据保存在受认证保护的数据库中。[personal-stock-review-system](https://github.com/liangmouse/personal-stock-review-system)

## 运行

1. 安装 Node.js 22 LTS 和 npm，执行 `npm ci`。
2. 在 Neon 创建开发数据库。从 Connect 获取带 TLS 的 PostgreSQL 连接信息。运行应用时使用 pooled 地址，执行迁移时使用数据库所有者的 direct 地址。
3. 复制 `.env.example` 为 `.env.local`。设置服务端 `DATABASE_URL`、`JOURNAL_API_TOKEN`、`JOURNAL_WEB_PASSWORD` 和 `JOURNAL_MCP_TOKEN`。分别使用密码管理器或 `openssl rand -hex 32` 为 API、网页和 MCP 生成独立凭据。
4. 在本机独立 shell 中将 `DATABASE_URL` 临时设为开发库的 direct 地址，执行 `npm run db:migrate`。迁移仅由部署者执行。退出该 shell 后，应用使用 `.env.local` 中的运行时连接。
5. 执行 `npm run dev`。本地默认监听端口为 3000。只将令牌用于本机测试或 HTTPS 请求。

部署者使用迁移账号应用 Drizzle 迁移；运行时和只读备份账号分别授权，具体权限见 `scripts/deploy/production-grants.sql`。生产密钥存入部署平台的服务端环境变量。备份凭据和迁移凭据由部署者独立保存。

## Web 工作台

| 页面 | 用途 |
| --- | --- |
| `/` | 显示事件总数、仍在进行的订单数、尚无复盘的订单数，以及最近入账的六条事件。 |
| `/events` | 按标的、方向、操作、订单当前状态和发生日期筛选。自然日按上海时区计算；发生时间未知的事件在启用日期过滤时不会匹配。 |
| `/orders/{id}` | 按记账序号查看事件、数量、价格、实际发生时间、入账时间和来源。 |
| `/reviews` | 查看待复盘和已复盘订单，进入 `/orders/{id}/review` 创建或修改复盘。 |

网页登录使用独立的 `JOURNAL_WEB_PASSWORD`，建议使用至少 24 个可打印、无空格的随机 ASCII 字符。浏览器仅接收有签名的 HttpOnly 会话 Cookie，生产环境强制 Secure，12 小时失效。轮换 Web 密码会使已签发的会话失效。复盘编辑使用版本号校验，旧页面保存会提示重新加载；已成功的请求可凭原幂等键取得原回执。复盘只改变该订单的复盘内容。

## Schema 和记账语义

| 表 | 作用与约束 |
| --- | --- |
| `orders` | UUID 主键，保存标的、方向、订单类型、限价、委托量、累计成交量和当前状态。普通订单必须声明委托量。 |
| `order_events` | 每笔事件以外键关联订单。事件保存类型、价格、数量、备注、实际发生时间、系统入账时间和顺序。全局唯一幂等键和请求摘要用于识别重复写入与冲突。 |
| `reviews` | 订单外键唯一，保存下单计划、是否遵守、执行复盘、偏差和改进。 |
| `review_write_receipts` | 为每次复盘写入保留唯一请求键、请求摘要、订单、复盘 ID 和版本。 |
| `write_rate_limit` | API 写入、网页登录和复盘保存各用一条分钟计数，全实例共享。 |

价格与数量使用 PostgreSQL 精确十进制。API 用 JSON 字符串收发这些值，最多 12 位整数、8 位小数。现阶段价格单位为 USD，数量单位为股。实际发生时间 `occurred_at` 需要带时区，精确到毫秒以内。仅知道报告日期、交易时段时，可写进备注，实际发生时间留空。系统自动生成 `recorded_at`。

委托 2 股、成交 1 股、撤销余量后，订单状态为 `CANCELLED`，累计成交仍为 1。成交必须给出成交价格和本次数量。撤单始终关闭整笔剩余委托，显式提供的 `cancelled_quantity` 须等于账面余量。省略时事件数量保留 NULL，表示用户未报告撤销量。成交和撤单只接受订单 UUID。终态拒绝新的写入，已成功请求仍可凭原幂等键重放。

写事务先按幂等键加事务锁，再检查既有事件。对于已有订单，再锁定订单行、校验状态并同时提交订单变更和新事件。事件只追加。数据库触发器拒绝修改、删除和清空事件表。历史导入应保留来源编号和未知字段。例如，虚构的 legacy_import 记录可使用来源编号 DEMO-LEGACY-01；未知价格和时间保持为空，且只记录已确认的事件。项目初始化不会导入私人交易记录。

## HTTP API

所有请求须携带 `Authorization: Bearer <JOURNAL_API_TOKEN>`。写请求的 Content-Type 为 `application/json`，请求体上限 16 KiB。单用户所有实例合计每自然分钟最多接受 60 个已认证的写请求，含重试和校验失败的请求。

| 方法 / 路径 | 输入或用途 |
| --- | --- |
| POST /api/orders | 创建委托。必填 symbol、side、quantity、idempotency_key。可选 order_type、limit_price、occurred_at、note。LIMIT 需要限价。 |
| POST /api/orders/{id}/fills | 记录成交。必填 price、quantity、idempotency_key。 |
| POST /api/orders/{id}/cancel | 撤销剩余委托。必填 idempotency_key，可选 cancelled_quantity。 |
| GET /api/orders | 筛选及分页查询订单。 |
| GET /api/orders/{id} | 查询订单和同一数据库快照下的完整事件时间线。 |

列表支持 `symbol`、`status`、`side`、`from`（含）、`to`（不含）、`page` 和 `page_size`（默认 25，上限 100）。时间范围匹配至少一条已知实际发生时间的事件。返回 `items`、`page`、`page_size`、`total`。订单详情返回 `order` 和按记账顺序排列的 `events`，每条保留自己的实际时间。

成交、撤单也接受可选 occurred_at 和 note。下面是一个用于开发库的虚构委托请求体，每条新操作生成一个全局唯一的幂等键，并为其所有重试保留原键。

```json
{
  "symbol": "DEMO",
  "side": "BUY",
  "order_type": "LIMIT",
  "limit_price": "12.50",
  "quantity": "2",
  "idempotency_key": "example-demo-order-001"
}
```

首次成功写入返回 HTTP 201 和 `{ok, order_id, event_id, replayed:false}`，同一请求重放返回 200、原始两个 ID 和 `replayed:true`。同键异参、超额成交或状态冲突返回 409。失败响应为 `{ok:false, error:{code,message}}`。遇到超时、503 或连接中断，保留请求内容和原键重试。429 使用 Retry-After。客户端只在取得成功回执后确认入账。

## Agent 与 ChatGPT 接入

MCP 客户端向应用域名的 `/mcp` 发送 Streamable HTTP 请求，并在请求头发送 `Authorization: Bearer <JOURNAL_MCP_TOKEN>`。握手、工具发现、查询和写入均须鉴权。请求体上限为 128 KiB。订单写入与 HTTP API 共享每分钟 60 次的限额，复盘写入与网页共享每分钟 30 次的限额。

| 工具 | 输入和回执 |
| --- | --- |
| `create_order` | 按用户明确提供的标的、方向和数量创建委托。限价单须带限价。返回订单和挂单事件 ID。 |
| `record_fill`、`cancel_order` | 传已确认订单的 UUID。成交须传价格与数量的十进制字符串；撤单可传已确认的剩余数量。返回订单和事件 ID。 |
| `list_orders`、`get_order_detail` | 按标的、方向、状态或已知发生时间筛选。按 UUID 获取事件及当前复盘。出现多个候选时须请用户选定。 |
| `update_review` | 传订单 UUID、读取到的版本和全部五个复盘字段。尚无复盘时版本为 0。保留已有内容，明确需要清空的字段传 null。返回订单 ID、复盘 ID 和版本。 |

为每个新写操作生成独立的 `idempotency_key`。重试原请求时保留原键和参数。读取工具成功结果中的 `structuredContent.ok` 和回执 ID 后才向用户确认；处理工具错误时检查 `isError`，并同时处理协议错误和 HTTP 错误。复盘版本冲突后重新读取，再由用户确认修改。

在 ChatGPT 插件页添加自定义 MCP 服务器，填写工作台「连接 Agent」提供的 HTTPS 地址。认证方式选 OAuth，客户端 ID 为 `journal-chatgpt`，客户端密钥使用本环境独立生成的 `JOURNAL_OAUTH_CLIENT_SECRET`。在交易日志的授权页核对域名，使用网页登录密码授权，再回到 ChatGPT 扫描六个工具。[ChatGPT 连接说明](https://developers.openai.com/plugins/deploy/connect-chatgpt)

部署 OAuth 时设置固定的 `JOURNAL_PUBLIC_ORIGIN`（含 HTTPS 协议、无路径）。授权端仅接受 ChatGPT 的精确回调地址、授权码和 S256 PKCE。访问令牌有效期为一小时，授予 `offline_access` 后可轮换刷新令牌，最长三十天。数据库存储令牌摘要。更换网页登录密码会使旧授权失效。其他支持自定义 Bearer 头的客户端可继续使用独立的 `JOURNAL_MCP_TOKEN`。受 Vercel 保护的预览另需通过 Vercel 访问保护。[MCP SDK](https://ts.sdk.modelcontextprotocol.io/v2/) · [ChatGPT MCP 认证](https://developers.openai.com/plugins/build/auth)

## 验收

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

测试在临时目录启动 PostgreSQL，运行项目迁移并使用合成数据。生产构建独立于数据库连接。变更 Schema 后用 `npm run db:generate` 生成并审阅新迁移，通过临时数据库测试后再应用。

## Vercel 预览与 Neon 联调

Vercel 项目使用 Hobby、Next.js 预设和 Node.js 22。Neon Free 项目为预览环境提供独立数据库分支 `phase2-preview`。运行时使用低权限角色的 pooled 地址，迁移使用该分支所有者的 direct 地址。将上述四个变量配置在 Vercel 的 Preview 环境，并对预览分支运行迁移。

Vercel CLI 要求此项目的首次部署使用 Production。首次发布后，可从项目根目录执行 `vercel deploy --environment preview` 发布预览。受 Vercel 访问保护的预览会先验证 Vercel 身份，再由应用登录页验证个人访问密码。

## 逻辑备份和恢复

使用与数据库同主版本或更新的 PostgreSQL 客户端。为备份源和**新建的空恢复库**配置本机 libpq 服务名 `journal_backup`、`journal_restore`，均指向 direct 连接，并在密码文件或凭据管理工具中提供凭据。备份应覆盖 public 表、序列、触发器和 drizzle 迁移历史。下列命令在仓库以外的受保护目录执行。

```sh
umask 077
backup_file="journal-$(date -u +%Y%m%dT%H%M%SZ).dump"
PGSERVICE=journal_backup pg_dump --format=custom --no-owner --no-acl --file="$backup_file"
pg_restore --list "$backup_file"
PGSERVICE=journal_restore pg_restore --dbname="service=journal_restore" --single-transaction --exit-on-error --no-owner --no-acl "$backup_file"
```

在恢复库核对订单、事件、复盘和迁移行数，以及典型订单的事件顺序与累计成交量。用同一请求和幂等键对恢复库重放一次，应返回原订单和事件 ID，行数保持一致。恢复后重新授予运行时角色所需权限。备份文件含完整私人交易信息，须加密后存放在独立于 Neon 的位置。生产备份的调度、保留周期和定期恢复演练在部署阶段配置。[Neon 逻辑备份](https://neon.com/docs/manage/backup-pg-dump)

本地已在 PostgreSQL 16.2 完成一次恢复演练。使用 3 笔合成订单、5 条事件、1 份复盘进行全库逻辑备份，恢复到空库后，业务表、限流计数和两条迁移记录的逐行摘要均一致。通过生产构建的 HTTP 服务重放创建请求，返回了原订单和事件 ID。

## 平台依据

Next.js App Router 提供 Route Handlers，Node.js 运行时通过 pg 和 Drizzle 访问 Neon，事务内持有同一连接。Neon 的池化端点使用 PgBouncer。[Next.js](https://nextjs.org/docs/app/getting-started/route-handlers) · [Drizzle 事务](https://orm.drizzle.team/docs/transactions) · [Neon 连接池](https://neon.com/docs/connect/connection-pooling)

Neon Free 当前列出每项目每月 100 CU-hours 和 1 GB 存储。Vercel Hobby 面向个人用途，当前每月包含 100 万次函数调用和 4 CPU-hours。部署时重新检查额度。本应用使用 MCP 官方 TypeScript SDK v2 的无状态 HTTP 处理器。[Neon Free](https://neon.com/pricing) · [Vercel Hobby](https://vercel.com/docs/plans/hobby) · [Vercel 条款](https://vercel.com/legal/terms) · [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/v2/)
