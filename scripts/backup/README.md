# 本机加密逻辑备份

每天按本机时区凌晨 03:15 执行 `pg_dump`，并通过 OpenSSL CMS AuthEnvelopedData 的 AES-256-GCM 认证加密写入 `~/Library/Application Support/TradingJournalBackup/snapshots`。PostgreSQL custom archive 经管道直接送入加密器，不在磁盘生成未加密 dump。加密文件先写入同目录临时文件，验证通过后以不覆盖现有快照名的方式原子发布。最近 30 天快照保留在本机。备份失败会返回非零状态，不会清理旧快照。

这份副本独立于 Neon，但仍在运行应用的 Mac 上。为了应对电脑故障，需要另行将加密快照复制到独立介质。首次配置会自动生成单独的加密 RSA 私钥、接收证书和随机恢复口令，保存于 `recovery/`，不要求人工输入密钥。请把 `private-key.pem` 与 `restore-passphrase` 分别保存在离线位置。日常备份只需要公开接收证书。即使数据库密码轮换，也不影响现有快照解密。

## 准备数据库角色

为直接 Neon 地址创建专用只读备份角色。它只能连接、读取 public schema 的应用表和 drizzle schema 的迁移记录。用密码管理器生成一次性使用的强随机数据库密码，将该密码写入独立的 owner-only 文件供本机脚本读取，勿保存到公开代码库。

```sql
CREATE ROLE journal_backup LOGIN PASSWORD '从密码管理器临时提供的随机密码';
GRANT CONNECT ON DATABASE neondb TO journal_backup;
GRANT USAGE ON SCHEMA public, drizzle TO journal_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public, drizzle TO journal_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public, drizzle TO journal_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE journal_app IN SCHEMA public
  GRANT SELECT ON TABLES TO journal_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE journal_app IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO journal_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE journal_app IN SCHEMA drizzle
  GRANT SELECT ON TABLES TO journal_backup;
```

数据库名和默认特权的对象所有者要对应实际环境。此只读角色需能读取将来新增的表。迁移若由其他角色执行，需为该迁移角色也配置相同的默认只读特权。

## 首次配置

要求 macOS、Node.js、Homebrew、PostgreSQL 17 或更高版本的 libpq 客户端，以及支持 AES-256-GCM authenticated CMS 的 Homebrew OpenSSL 4。PostgreSQL 客户端以 Homebrew keg-only 安装，不创建全局命令链接。

```sh
brew install libpq openssl@4
mkdir -m 700 -p "$HOME/Library/Application Support/TradingJournalBackup/input"
```

默认私有配置目录为 `~/Library/Application Support/TradingJournalBackup`。如需放到另一块本机受保护磁盘，可给配置器、备份、恢复及调度安装命令传入 `--config-dir DIRECTORY`；目录必须由当前用户拥有且权限为 `700`。

把数据库角色密码写入本机受保护的单行文件 `~/Library/Application Support/TradingJournalBackup/input/backup-password`，并将其权限设为 `600`。运行：

```sh
chmod 600 "$HOME/Library/Application Support/TradingJournalBackup/input/backup-password"
node scripts/backup/configure.mjs \
  --host ep-your-direct-endpoint.us-east-1.aws.neon.tech \
  --database neondb \
  --role journal_backup \
  --password-file "$HOME/Library/Application Support/TradingJournalBackup/input/backup-password"
```

将命令中的直接数据库地址替换为 Neon Connect 提供的 direct endpoint。配置程序校验连接地址和权限文件，建立 TLS 校验连接配置，并用本机 OpenSSL 非交互生成加密备份私钥和随机口令。它不创建或修改云端数据库角色，也不启动定时任务。恢复私钥和口令必须单独离线保管，遗失二者之一将无法恢复快照。

首次使用前，在 Neon 为 `journal_backup` 配置上述只读 SQL 权限。备份先确认 `drizzle.__drizzle_migrations` 存在，再只导出 public 与 drizzle 两个应用 schema，并排除 PostgreSQL extensions；Neon 托管系统与扩展不在此备份范围内。然后运行一次 `scripts/backup/backup.sh`。只有输出快照文件名且命令退出码为 0 才代表备份成功。凭据、认证信息、SQL 错误详情不输出到日志。

## 安装每日调度

先验证 launchd plist：

```sh
scripts/backup/install-launchd.sh
```

该命令在临时目录校验 plist 和当前用户的 launchd 域，不写入持久配置或加载服务。核对无误后安装配置文件：

```sh
scripts/backup/install-launchd.sh --install
```

它会写入 `~/Library/LaunchAgents/com.personal-trading-journal.backup.plist`，但不会加载任务。审阅文件后再运行提示中的 `launchctl bootstrap` 命令启用每日任务。应用退出或 Mac 休眠时 launchd 会在机器可运行时补做错过的日历任务。日志位于私有 `logs/` 目录。

## 恢复到新数据库

先在 Neon 创建全新、空的恢复数据库和单独的恢复登录角色。该角色需要在空库中创建 schema/table/index/sequence 并写入数据；可将新库设为该角色所有者，并授予它在默认 `public` schema 中的 `CREATE` 权限。示例：

```sql
CREATE ROLE journal_restore LOGIN PASSWORD '从密码管理器临时提供的随机密码';
CREATE DATABASE journal_recovery OWNER journal_restore;
GRANT CREATE ON SCHEMA public TO journal_restore;
```

恢复目标要预先安装应用实际依赖的 PostgreSQL extensions；快照不包含扩展定义和扩展拥有的对象。恢复完成后，如不再需要，可撤销额外权限。把角色密码放在 owner-only 文件，然后登记恢复连接：

```sh
node scripts/backup/configure-recovery.mjs \
  --host ep-new-direct-endpoint.us-east-1.aws.neon.tech \
  --database journal_recovery \
  --role journal_restore \
  --password-file "$HOME/Library/Application Support/TradingJournalBackup/input/restore-password"
```

权限为 `600`。恢复数据库名或 direct endpoint 必须与备份源不同。恢复脚本还会检查目标可写，且 public/drizzle 中没有非 extension 对象、没有大对象或已有 drizzle schema；默认 public schema 和其中 extension 拥有的对象可保留。它从 archive 清单中略过 `public` 的 schema 创建条目，因此不会尝试删除或重建目标的默认 schema。恢复不传 `--clean`，不会覆盖对象；恢复中任一步失败时，单个 PostgreSQL 事务回滚全部改动。

恢复过程先将 CMS 解密到 `/dev/null`，验证 GCM 认证标签，通过后才开启 PostgreSQL 恢复事务。明文不会落盘。只允许显式执行：

```sh
scripts/backup/restore.sh --restore \
  "$HOME/Library/Application Support/TradingJournalBackup/snapshots/journal-YYYYMMDDTHHMMSSZ.cms"
```

恢复后，使用只读查询对比订单、事件、复盘、幂等回执和 Drizzle 迁移记录的行数，并检查订单事件顺序及复盘版本。再为运行时数据库角色重新授予所需访问权限。逻辑快照不含 PostgreSQL 角色定义。

目标服务段示例（配置程序自动生成）：

```ini
[journal_restore]
host=ep-new-direct-endpoint.us-east-1.aws.neon.tech
port=5432
dbname=journal_recovery
user=journal_restore
sslmode=verify-full
sslrootcert=/etc/ssl/cert.pem
application_name=personal-trading-journal-restore
```

在 `pgpass` 中为恢复端点添加独立密码行，格式为 `host:5432:database:role:password`。密码中的反斜杠和冒号须分别写成 `\\` 和 `\:`。

## 验收

使用临时 PostgreSQL 数据库验证创建密钥、TLS 服务配置、encrypted backup、认证标签失败保护、事务恢复以及 public 与 drizzle schema 的空目标检查。PostgreSQL 默认 schema 与 extension 拥有的对象不会阻断恢复。恢复后比较下列行数：

```sql
SELECT 'orders', count(*) FROM orders
UNION ALL SELECT 'order_events', count(*) FROM order_events
UNION ALL SELECT 'reviews', count(*) FROM reviews
UNION ALL SELECT 'review_write_receipts', count(*) FROM review_write_receipts
UNION ALL SELECT 'drizzle_migrations', count(*) FROM drizzle.__drizzle_migrations;
```

## 文件保护

根目录、快照与恢复目录权限为 `700`。配置、密码、接收证书、私钥和恢复口令权限为 `600`。密钥使用者可读取认证信息和数据库口令。OpenSSL 认证加密保护快照完整性。明文 dump 只通过进程管道传递。
