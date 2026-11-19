# 个人交易流水

单用户股票交易记录服务。Phase 1 提供受保护的订单 API、Drizzle 迁移和真实 PostgreSQL 验收测试。首页只显示应用名称。Dashboard、复盘编辑、ChatGPT MCP 接入及生产部署按后续阶段实施。

项目源码公开托管在下列 GitHub 仓库。应用密钥保存在服务端环境变量中，交易数据保存在受认证保护的数据库中。[personal-stock-review-system](https://github.com/liangmouse/personal-stock-review-system)

## 运行

1. 安装 Node.js 22 LTS 和 npm，执行 `npm ci`。
2. 在 Neon 创建开发数据库。从 Connect 获取带 TLS 的 PostgreSQL 连接信息。运行应用时使用 pooled 地址，执行迁移时使用数据库所有者的 direct 地址。
3. 复制 `.env.example` 为 `.env.local`。设置服务端 `DATABASE_URL` 和 `JOURNAL_API_TOKEN`。令牌应由密码管理器生成，或用 `openssl rand -hex 32` 在本机生成。将来接入 MCP 时单独配置认证凭据。
4. 在本机独立 shell 中将 `DATABASE_URL` 临时设为开发库的 direct 地址，执行 `npm run db:migrate`。迁移仅由部署者执行。退出该 shell 后，应用使用 `.env.local` 中的运行时连接。
5. 执行 `npm run dev`。本地默认监听端口为 3000。只将令牌用于本机测试或 HTTPS 请求。

运行时数据库角色需要 public schema 的 USAGE、orders 的 SELECT/INSERT/UPDATE、order_events 的 SELECT/INSERT、write_rate_limit 的 SELECT/INSERT/UPDATE。生产密钥存入部署平台的服务端环境变量。备份凭据和迁移凭据由部署者独立保存。

## Schema 和记账语义

| 表 | 作用与约束 |
| --- | --- |
| `orders` | UUID 主键，保存标的、方向、订单类型、限价、委托量、累计成交量和当前状态。普通订单必须声明委托量。 |
| `order_events` | 每笔事件以外键关联订单。事件保存类型、价格、数量、备注、实际发生时间、系统入账时间和顺序。全局唯一幂等键和请求摘要用于识别重复写入与冲突。 |
| `reviews` | 订单外键唯一，保存下单计划、是否遵守、执行复盘、偏差和改进。 |
| `write_rate_limit` | 单用户共用一条分钟计数，数据库原子更新，全实例共享。 |

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

## 验收

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

测试在临时目录启动 PostgreSQL，运行项目迁移并使用合成数据。生产构建独立于数据库连接。变更 Schema 后用 `npm run db:generate` 生成并审阅新迁移，通过临时数据库测试后再应用。

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

截至 2026-11-19，Next.js App Router 提供 Route Handlers，Node.js 运行时通过 pg 和 Drizzle 访问 Neon，事务内持有同一连接。Neon 的池化端点使用 PgBouncer。[Next.js](https://nextjs.org/docs/app/getting-started/route-handlers) · [Drizzle 事务](https://orm.drizzle.team/docs/transactions) · [Neon 连接池](https://neon.com/docs/connect/connection-pooling)

Neon Free 当前列出每项目每月 100 CU-hours 和 1 GB 存储。Vercel Hobby 面向个人用途，当前每月包含 100 万次函数调用和 4 CPU-hours。部署时重新检查额度。MCP 官方 TypeScript SDK 提供独立的服务端包和远程 HTTP 传输，接入阶段再确定依赖及认证方式。[Neon Free](https://neon.com/pricing) · [Vercel Hobby](https://vercel.com/docs/plans/hobby) · [Vercel 条款](https://vercel.com/legal/terms) · [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/v2/)
