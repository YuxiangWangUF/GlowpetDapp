# Glowpet 无钱包门槛版本：Agent 执行手册

版本：v1.1

编写日期：2026-10-24；状态核对：2026-10-28（Asia/Shanghai）

原始实施基线提交：f620d62；当前交接版本请查看仓库 Git 记录。

文档状态：实现约束与完整验收规格。账户适配、API、数据库迁移、代付 worker 和云花园已实现并本地验证；真实 Privy、生产服务、Sepolia 和独立设备验收尚未完成。跨设备接手先读 [AGENT_HANDOFF.md](AGENT_HANDOFF.md)，实际运行以 [ONBOARDING_DEPLOYMENT.md](ONBOARDING_DEPLOYMENT.md) 为准。下文尚未完成的验收项仍是目标，不表示已上线。

## 1. 给执行 Agent 的任务

在现有 GlowpetDapp 上实现：

**游客试玩 → 邮箱验证码登录 → 自动获得固定用户钱包 → 扫描挂件 → 平台代付领取 → 跨设备继续养宠。**

完成代码、数据库迁移、配置样例、自动化测试和部署说明。在真实服务配置齐全时完成 Sepolia 端到端验证；缺少配置时完成所有不依赖它的工作，并准确列出尚未验证的部分。

本轮只实现本手册范围，不顺带重做 UI、宠物美术、合约经济模型或发行规则。

### 用户可见的完成标准

1. 没有 MetaMask、钱包余额为 0 的新用户，可以用邮箱领取一个有效挂件对应的宠物。
2. 用户不需要安装插件、手动切链、领测试币或备份助记词才能完成首次领取。
3. 第二台设备登录同一账号，得到同一个钱包地址，并看到同一只宠物和已同步的养成进度。
4. 重复点击、刷新、网络超时和服务重启不会造成重复发宠物或重复提交领取交易。
5. 已有钱包的用户仍能使用现有外部钱包入口；未登录用户仍能试玩和查看公开宠物。
6. 产品明确区分“本机试玩”“云端花园”“领取处理中”和“领取已确认”。

## 2. 当前仓库事实

| 模块 | 当前能力 | 本轮改造点 |
| --- | --- | --- |
| [src/App.jsx](../src/App.jsx) | 已接账户适配层、内嵌钱包代付 API；保留外部钱包直接领取 | 补真实身份服务、配置与跨设备验收 |
| [src/wallet-state.js](../src/wallet-state.js) | 监听浏览器钱包，防止过期初始化覆盖新账号 | 保留外部钱包逻辑，避免与内嵌钱包状态串用 |
| [src/claim-authorization.js](../src/claim-authorization.js) | 挂件 credential 在浏览器签署 EIP-712 授权 | 复用算法及域，后台仅接收公开授权 |
| [contracts/Glowpet.sol](../contracts/Glowpet.sol) | v2 claim 支持任意提交者；NFT 铸给 recipient | 本轮无需为代付修改合约 |
| [src/garden-state.js](../src/garden-state.js) | 转出 shared/garden-state.js，共享纯规则、schema v2、revision | 服务端动作和时间校验已实现，补正式服务验收 |
| [src/useGardenGame.js](../src/useGardenGame.js) | localStorage、浏览器锁与可选云端适配 | 游客与云存档分离，补真实设备验收 |
| [docs/v2-series.json](v2-series.json) | generated_not_deployed，contractAddress 为 null | 必须核实真实部署，不能把样例当已部署合约 |
| [output/imagegen](../output/imagegen/README.md) | 保留中国元素概念图；另有 v2 组合生成器及 100 张完整立绘 | 美术进展见 [DELTAX_NFT_ART.md](DELTAX_NFT_ART.md)，不影响本文账户验收范围 |

后端、数据库迁移、账户系统和 relayer 已有代码与本地验证；公开游客站尚未接入正式账号或 NFT 服务。链上 evolve 仍为 onlyOwner，不自动进化。

最近交接验证见 [AGENT_HANDOFF.md](AGENT_HANDOFF.md)。执行 Agent 必须在自己的环境重跑适用检查，不能把历史结果写成当前验证结果。

## 3. 实施决策与边界

### P0：本轮必须交付

- Privy 邮箱登录、用户控制的内嵌 EVM EOA 钱包、登录恢复、退出及账户设置。
- 同一身份重复登录恢复原钱包；首次创建使用 SDK 的已有钱包检查，禁止每次登录新建。
- Sepolia 上仅针对允许的 Glowpet 合约与系列代付 claim。
- 后端验证身份和钱包归属、领取队列、交易恢复、限流与费用上限。
- 已领取宠物的云端花园，客户端提交动作，服务器计算状态。
- 公开宠物展示、挂饰预览、游客花园、现有外部钱包直接领取保持可用。
- 安全的凭证 URL 处理、配置隔离、日志脱敏和完整故障测试。

### 本轮不包含

- 主网发行、支付/充值、交易市场、批量转赠、通用 Gas 代付。
- ERC-4337、Paymaster、EIP-7702、用户钱包服务器代签或宽泛会话权限。
- 微信登录、真实 BLE、自动链上进化、中国元素换装。
- 将历史本机 XP 或试玩奖励兑换成链上权益。

首次免 Gas 的准确范围是“平台代付领取”。普通 ERC-721 转移不能直接套用 claim 的代付方式，后续单独设计。

### 默认技术选型

- 前端：继续 React + Vite + ethers，增加 Privy React SDK。
- 后端：Node.js 24 LTS、Fastify、ethers、Privy 官方 Node SDK。
- 数据库：PostgreSQL，使用 pg 与版本化 SQL 迁移。
- 队列：先使用 PostgreSQL 任务表与事务锁，不额外引入 Redis。
- 测试：保留 node:test 与 Hardhat；API/数据库集成测试使用独立测试数据库。
- SDK 精确版本由执行时官方文档、peer dependencies 和锁文件确认；不得盲用旧示例或未经验证的 latest。

若现有部署环境有等效技术约束，可替换后端框架，但需保持本文接口、不变量和验收范围。不要为接入账户系统迁移整个前端框架。

## 4. 用户流程与账户模型

### 登录与钱包

1. 主入口使用“登录 / 领取我的宠物”，现有用户可选择“使用已有钱包”。
2. 邮箱验证码由身份服务提供；后端仍独立校验其 access token。
3. 登录后读取已有用户钱包；仅在没有钱包时创建，等待地址可用后开放领取。
4. 后端从已验证的提供方用户信息获取钱包 ID、类型及地址，不信任客户端传来的邮箱或地址。
5. 用提供方的 issuer + subject 作为稳定身份；邮箱只做展示，不作为数据库主键。
6. “连接到页面的钱包”不自动等于“已通过后端验证的账号钱包”。
7. P0 内嵌钱包用户获得云端与代付能力；外部钱包保留原直接领取。本轮若提供外部钱包云端能力，必须额外完成可信账号关联或一次性签名 challenge 验证，禁止仅凭 address 登录。
8. 不自动合并“同邮箱”“同昵称”或未验证的不同钱包账号，也不把已领取 NFT 自动转移到新钱包。

账户适配层建议暴露：

~~~text
status: loading | guest | authenticated | error
mode: guest | embedded | external
accountId, address, chainId
login(), logout(), getAccessToken(), getExternalSigner()
~~~

前端统一从这个层读取当前身份。登出、切换账号或 recipient 改变时，清理内存中的待签授权、旧花园缓存和订阅，取消过期请求；不得复用前一账号的授权。

### 凭证跨登录的处理

- 扫码得到的挂件 secret 只存在当前页面内存中；不要写入 localStorage、sessionStorage 或 IndexedDB。
- 优先邮箱弹层登录，避免整页重定向丢失内存凭证。
- 如果页面刷新或身份流程需要跳转，恢复登录后提示“请重新扫描挂件”；不得为无感体验上传或持久化 secret。
- 清理浏览器 URL 后再初始化第三方 SDK、analytics 和错误上报。

### 账户恢复与退出能力

- 提供备用登录方式/Passkey 配置入口，并明确丢失唯一登录方式的后果。
- 钱包导出使用提供方受保护的官方 UI；应用服务端不读取、代理或记录用户私钥。
- 对导出、修改恢复方式等敏感操作要求重新验证；具体行为遵循实际 SDK 能力并验证。
- 不把“创建一个新地址”称为恢复；验收必须对比恢复前后地址。

## 5. 建议目录与 Agent 分工

以下结构已部分按实际实现落地，检查现有代码后再扩展，避免重复搭建。入口与实际文件映射见 ONBOARDING_DEPLOYMENT.md：

~~~text
src/auth/                  账户适配、登录和恢复 UI
src/api/                   认证请求、claims、garden 客户端
src/claim-bootstrap.js     SDK 初始化前的凭证捕获与 URL 清理
src/useCloudGardenGame.js  云花园适配，保持现有组件调用方式
server/config.js
server/auth/
server/routes/
server/services/
server/worker-entry.js
server/db/migrations/
server/test/
docs/ONBOARDING_DEPLOYMENT.md
~~~

| 工作包 | 负责范围 | 必须交付 | 依赖 |
| --- | --- | --- | --- |
| A：登录 | src/auth、SDK 集成、账户 UI、请求凭证 | 邮箱登录、固定地址恢复、现有钱包兼容 | 主 Agent 先锁定接口 |
| B：代付 | server/auth、claim API、worker、费用控制 | 身份核验、数据库状态机、恢复测试 | 共享 schema 与 A 的身份契约 |
| C：云花园 | garden API、存储适配、并发控制 | 跨设备同步、幂等、所有权校验 | A 的用户模型，现有 reducer |
| 主 Agent | 共享 schema、依赖锁文件、App 接线、文档 | 端到端整合、配置、验收报告 | A/B/C |

并行前先约定字段、错误码和文件归属。只有主 Agent 修改 package.json/锁文件及 App.jsx 的最终接线，避免互相覆盖。

## 6. 配置约定

根目录 .env.example 继续只包含可公开的前端变量：

~~~dotenv
VITE_AUTH_MODE=privy
VITE_PRIVY_APP_ID=public_app_id
VITE_API_BASE_URL=/api/v1
VITE_GLOWPET_ADDRESS=verified_sepolia_contract
VITE_GLOWPET_SERIES_ID=1
VITE_SEPOLIA_RPC_URL=public_read_rpc
~~~

后端提供 server/.env.example，全部使用占位符：

~~~dotenv
NODE_ENV=development
PORT=3001
DATABASE_URL=postgres_connection_string
PRIVY_APP_ID=matching_app_id
PRIVY_APP_SECRET=set_in_server_secret_store
CHAIN_ID=11155111
RPC_URL=server_rpc
GLOWPET_ADDRESS=verified_sepolia_contract
ALLOWED_SERIES_IDS=1
RELAYER_PRIVATE_KEY=set_in_server_secret_store
RELAYER_ENABLED=false
CLAIM_CONFIRMATIONS=2
CLAIM_AUTH_MAX_TTL_SECONDS=600
RELAYER_MAX_GAS_PER_TX=configure_from_measured_claim_estimates
RELAYER_MAX_FEE_PER_GAS_WEI=configure_explicitly
RELAYER_DAILY_BUDGET_WEI=configure_explicitly
ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
~~~

- 费用上限须为合法整数，缺失或非法时关闭广播；不使用无限默认值。
- 两个区块确认只是 Sepolia P0 的验收配置，不意味着不可重组的最终性。
- Relayer 使用独立、低余额、无 owner 权限的普通地址；不能与人工操作或其他程序共用发送账户。
- 在 .gitignore 中覆盖嵌套环境文件；前端构建不得导入 server 配置。
- 本地 mock 身份必须只在明确测试模式下启用，生产启动检测到 mock 配置直接失败。
- 提供真实服务配置缺失时的可理解提示，不在真实页面显示假的“已登录/已领取”。

用户/部署方最终需要配置：Privy 应用与允许的 origin、邮箱登录设置、后端密钥、数据库、RPC、已验证的合约/系列、独立代付地址及测试余额。先完成可本地验证的实现，再集中列出缺失项；不要索要用户钱包私钥。

## 7. API 契约

所有私有接口使用 HTTPS 下的 Bearer access token。后端验证签名、issuer、audience、有效期和 subject；只解码 JWT 不算验证。用官方 SDK处理密钥轮换。P0 不自建邮箱验证码系统。

私有响应使用 Cache-Control: no-store。生产 CORS 限定实际 origin；反向代理 trust proxy 配置明确，防止伪造 IP 绕过限流。

金额、tokenId、seriesId 等链上大整数用十进制字符串传输和保存；serial 为经过 uint32 范围检查的整数。地址统一验证并规范化。请求 schema 禁止未知字段，并限制 body、proof 和字符串长度。

### 7.1 获取当前账号

~~~text
GET /api/v1/me
200 {
  accountId,
  wallet: { address, providerWalletId, kind: "embedded_eoa" },
  chain: { chainId: "11155111", contractAddress, allowedSeriesIds },
  capabilities: { sponsoredClaim, cloudGarden },
  serverTime
}
~~~

账户与钱包绑定来自可信服务端信息。钱包未准备好时返回可重试的明确状态，不用零地址或随意选择第一个 linked account。

### 7.2 提交领取任务

~~~text
POST /api/v1/claims
Authorization: Bearer ...
Idempotency-Key: <UUID>

{
  "seriesId": "1",
  "serial": 7,
  "credentialSigner": "0x...",
  "proof": ["0x..."],
  "recipient": "0x...",
  "deadline": "<Unix 秒十进制字符串>",
  "signature": "0x..."
}

202 { jobId, status, txHash?, pollAfterMs }
~~~

- 不接受 secret、seed、privateKey、claimUrl、RPC URL、to 或任意 calldata。
- 链、合约和允许的系列来自后端配置；recipient 必须是当前账号已验证的钱包。
- 授权域保持 name=Glowpet、version=2、实际 chainId 与 verifyingContract；字段顺序保持现有 CLAIM_TYPES。
- 同一个账号、同一个 Idempotency-Key、相同规范化请求：返回原任务。
- 相同 key、不同请求：409 IDEMPOTENCY_CONFLICT。
- 同一系列序号已有未决任务：相同账号/recipient 返回原任务；其他账号或 recipient 返回通用冲突，不泄露他人账号信息。
- POST 返回排队结果，不等待区块确认。前端请求超时后使用原 key 重试或查询任务。
- 登录过期只刷新身份 token，不自动换领取 key、recipient 或已提交授权。

### 7.3 查询和更新授权

~~~text
GET /api/v1/claims/:jobId
200 {
  jobId, status, txHashes, tokenId?,
  confirmations, requiredConfirmations,
  mintedToRecipient?, currentOwner?, errorCode?
}

POST /api/v1/claims/:jobId/authorization
Idempotency-Key: <new UUID>
{ deadline, signature }
~~~

查询仅允许任务所属账号。刷新后通过该账号的任务列表或幂等重试找回任务；提供 GET /api/v1/claims?status=active 的分页查询。

更新授权只允许相同账号、相同 recipient 和同一凭证：任务从未签署 relayer 交易，或全部旧 nonce 已有明确终态且确认没有领取成功。重新核验完整授权；与 worker 分配 nonce 使用同一事务锁。已签或广播结果不明的任务不能覆盖授权。P0 无法自动处理的 nonce 异常转人工对账，不无限分配新 nonce。

更新授权成功时，在同一事务提交新授权版本、幂等记录和回到 QUEUED 的状态。MINED_REVERTED 只有达到确认要求且旧 nonce 已终结，才允许重新授权和排队。

常用错误码：AUTH_REQUIRED、WALLET_NOT_READY、RECIPIENT_MISMATCH、INVALID_PROOF、INVALID_SIGNATURE、AUTHORIZATION_EXPIRED、SERIES_CLOSED、CLAIM_CONFLICT、RATE_LIMITED、SPONSOR_PAUSED、BUDGET_EXHAUSTED、CHAIN_UNAVAILABLE。返回可理解的文案，不把完整 provider 异常、请求体或密钥放入错误消息。

## 8. 代付服务实现要求

### 8.1 数据表和约束

| 表 | 核心字段/约束 |
| --- | --- |
| accounts | id；UNIQUE(issuer, subject) |
| wallet_bindings | account_id、chain_id、provider_wallet_id、normalized_address、验证版本；每账号目标链固定一个 P0 钱包 |
| claim_jobs | 账号、chain/contract/series/serial、固定 recipient、公开授权、状态、version；UNIQUE(chain_id, contract, series_id, serial) |
| idempotency_keys | account_id、key、规范化 request_hash、job_id；UNIQUE(account_id, key) |
| nonce_slots | chain_id、relayer_address、nonce、job_id、finalized_at；UNIQUE(chain_id, relayer_address, nonce)，并以部分唯一索引限制每个 job 至多一个未终结槽 |
| tx_attempts | slot_id、hash、raw_signed_tx、gas/fee、广播/receipt/区块信息；UNIQUE(chain_id, hash) |
| sponsor_budget | 预算周期、已花费、已预留；原子额度检查与预留 |

同 nonce 提价可以有多个 tx_attempts；不要把“一 nonce 只能有一 attempt”写成数据库约束。数据库写入领取任务和幂等记录必须在同一事务。钱包绑定不能被请求体任意更新。

### 8.2 提交前验证

1. 身份有效、账号钱包归属有效、recipient 一致。
2. RPC chainId、合约代码、claimProtocolVersion=2 与部署配置一致。
3. 系列存在且开放、序号/供应量有效；从链上读取 serialRoot，不信任客户端 root。
4. 按现有算法验证 Merkle proof、EIP-712 signature、deadline 和最大 TTL。
5. 检查 serialClaimed、既有 Claimed 事件和已有任务。
6. 使用 relayer 地址模拟 claim 并估算 gas，检查余额与费用上限。
7. 固定交易 to=配置合约、value=0、data=已验证参数编码的 claim。

无效请求不消耗链上手续费。实际广播前重新检查会变化的系列状态、授权期限和预算。

### 8.3 状态和交易恢复

正常路径：

~~~text
QUEUED → SIGNED → PENDING → MINED_SUCCESS → CONFIRMED
~~~

辅助状态：

- BROADCAST_UNKNOWN：RPC 超时，可能已广播。
- MINED_REVERTED：明确取得执行失败 receipt，仍要对账并等待所需确认。
- EXPIRED_UNSENT：未签署任何 relayer 交易的授权已过期。
- CLAIM_CONFLICT：确认的 Claimed 事件接收人与任务 recipient 不同，领取业务终结为冲突。
- NEEDS_RECONCILIATION：nonce 被未知交易占用、链上结果矛盾等，停止自动追加发送。

暂停使用独立 blockedReason / sponsorPaused 字段，不覆盖 SIGNED、PENDING 或 BROADCAST_UNKNOWN 等交易阶段。关闭新广播后仍查询和维护已发送交易。

硬性顺序：

1. 在同一事务按固定顺序锁定 job、relayer 和预算记录，重新核验 job 状态/version，以及是否已有未终结 nonce slot；再串行协调 nonce 和预算。仅锁 relayer 不能防止两个 worker 为同一 job 先后分配不同 nonce。
2. 结合本地未完成 nonce_slots 与链上 latest/pending nonce 完成对账，不能只取一个 RPC 值盲目分配。
3. 本地签署，计算交易 hash。
4. 持久化 nonce slot、raw_signed_tx、hash、费用预留和 job 状态，事务提交。
5. 持久化成功后才广播。
6. 网络结果不确定时，优先重发同一 raw_signed_tx，保持同一个 hash。
7. 提价使用同 nonce、同 chain/to/value/data；记录新 attempt，持续观察所有旧、新 hash。
8. 达到配置的确认数，并核验 receipt.blockHash 仍 canonical，再标记 CONFIRMED。

raw_signed_tx 是受限服务端记录，不是公开 API 字段，不写普通日志。只包含公开领取授权，不包含挂件 secret 或用户钱包私钥。

receipt=null、查不到 tx、nonce too low、请求超时都不等于失败。进程重启先恢复未完成任务，再接受新广播。已签交易即使授权过期也不能释放 nonce；必须对账或经过明确的同 nonce 取消流程，避免队列空洞。

已有领取成功的判断应查 canonical Claimed 事件和 serialClaimed。当前 ownerOf 可能因后续转移变化，不能据此把原领取判成失败，也不能把“已转给别人”显示为“当前仍归你”。

第三方提交的 Claimed 接收人与任务 recipient 相同时，记录该交易 hash，进入同样的 MINED_SUCCESS → CONFIRMED 流程；不同接收人在达到确认要求后才标记 CLAIM_CONFLICT。自己的交易随后 revert 不推翻已经核验的成功领取，交易费用单独结算。领取业务结束后，所有已签/已广播 nonce slot 仍须继续对账至终结，不能随业务状态直接释放。

### 8.4 费用与限流

- 账号和可信来源 IP 双层限流；OTP 限流交给身份服务并配置合理策略。
- 每次广播前原子预留最坏费用 gasLimit × maxFeePerGas；并发 worker 不得越过总预算。
- 同 nonce 加速更新该槽的最大费用预留，不按每个 attempt 当成独立完整交易，也不能提前释放旧交易可能消耗的余额。
- 依据最终 canonical receipt 结算实际费用，失败交易同样计费；跨天未决预留继续保留。
- 提供余额告警、暂停新广播、队列状态、失败原因及对账工具。
- metrics/logs 采用字段白名单，仅记录 requestId、jobId、状态、错误码、公开 tx hash 和必要费用信息。

## 9. 云端花园

### 9.1 数据归属

- P0 云花园绑定已验证账号与其当前持有的宠物。
- 唯一键为 account_id + chain_id + contract_address + token_id。
- 云接口严格校验资源标识，不能沿用 makeGardenKey 在参数无效时退回 guest 的行为。
- 私有读写检查账号钱包与链上 ownerOf；不能因知道 tokenId 就能读取他人存档或修改宠物。
- 写操作使用新鲜链上所有权检查，并记录所依据的 block number/hash；RPC 不可用时暂停写入。
- 链和数据库之间没有原子事务：转移事件发生后撤销旧账号写权限并重查，不宣称能消除所有区块间竞态。P0 无链上奖励结算，因此不把这些状态直接兑换权益。
- 转移后旧主人存档不能被新主人直接读取。新主人获得自己的花园；原账号日后重新持有同一宠物可恢复自己的历史花园，这是本轮默认规则。

### 9.2 API

~~~text
GET /api/v1/gardens/:tokenId
200 { state, revision: "42", rulesVersion, serverTime }

POST /api/v1/gardens/:tokenId/actions
{
  "actionId": "<UUID>",
  "expectedRevision": "42",
  "action": { "type": "plant", "cropId": "carrot", "plotIndex": 0 }
}
200 { actionId, state, revision: "43", rulesVersion, serverTime }
~~~

只接受 buy、plant、harvest、feed、play 及各自允许的字段，语义与现有 reducer 一致。禁止提交整份 state 或自定 coins、xp、readyAt、now。

数据库建议：

- gardens：归属键、schema_version、rules_version、state JSONB、独立 bigint revision、updated_at。
- garden_actions：garden_id、action_id、规范化 payload hash、结果快照/响应、处理时间；UNIQUE(garden_id, action_id)。

服务端事务步骤：

1. 认证和当前所有权检查；以可信账号构造 garden key。
2. 锁定花园记录，检查 actionId。已成功处理且请求一致时返回原响应，不重复执行。
3. 相同 actionId 不同 payload 返回 409 ACTION_ID_CONFLICT。
4. 检查 expectedRevision；冲突返回 409 REVISION_CONFLICT 和最新状态。
5. 使用服务器时间运行共享 advanceGame / getGardenActionError / reduceGame。
6. 无效动作不改状态、不发奖励；成功动作原子写入状态、revision 和幂等记录。

云端 revision 使用独立单调版本，不能依赖现有会在 MAX_COUNTER 饱和的游戏 revision 字段。schema version 与并发 revision 分开。

数据库取出的存档必须先校验；损坏时报警并返回 GARDEN_STATE_INVALID，保留原记录供恢复。不能沿用浏览器 normalizeGame/advanceGame 对坏数据静默 createGame 的降级。规则版本变化需明确迁移和测试，不能让不同 worker 用不同奖励规则处理同一花园。

读取可返回按服务器时间推导的显示状态，但倒计时刷新不持续写库或递增 revision。服务端时间取 max(serverNow, lastUpdated)，保持现有防时间倒退行为。

### 9.3 前端同步

- 保留 useGardenGame 供游客使用；增加云 store，保持 FarmScene/GardenView 的动作接口。
- 成功提交后使用服务端状态。其他设备通过页面重新聚焦、动作后拉取及适度轮询获得更新；P0 不强制 WebSocket。
- 冲突时先同步，原动作不自动换 actionId 再执行。用户基于新状态重新操作时产生新 ID。
- 请求超时可用同 actionId、原 payload 重试；不能因为响应丢失再次收获。
- 在发送前持久化账号隔离的非敏感 outbox（garden key、actionId、expectedRevision、动作参数），以便刷新后对账。它不含 credential、token 或钱包密钥，也不是奖励依据。退出后停止重发，仅在同一账号重新认证和资源权限验证后恢复；无法持久化时明确提示不要重复操作，并提供服务端动作回执查询。
- 登录云花园离线时允许查看缓存和倒计时，暂停消耗/奖励动作并展示“暂未连接”；游客花园仍可离线试玩。
- 登出/换号取消在途请求并隔离缓存，迟到响应不能写入另一个账号的 UI。

### 9.4 游客及旧本机存档

默认保留原本机练习存档，正式领取后创建可信云花园，明确说明两个存档的区别。

不自动导入本机 coins、food、seeds、xp、plots、时间和计数器。现有 isGardenState 只能证明格式合法，不能证明数值真实。若要留存历史，可单独备份为 unverified legacy archive，不进入正式余额、里程碑或 evolve 条件。

更复杂的试玩奖励迁移作为后续产品决策；不要用未经验证的客户端事件日志推导“可信奖励”。

## 10. 凭证 URL 与首屏初始化

当前生成器已把新领取载荷放在 fragment；src/claim-bootstrap.js 在 SDK 加载前捕获并清理 URL，仍兼容旧 query。继续维护以下约束并补真实部署日志验收：

1. 首先升级解析器，兼容 fragment 和旧 query；同一字段来源冲突时拒绝，不静默选择。
2. 新生成凭证把敏感领取载荷放 URL fragment，例如 #claim=...；编码只是封装，不是加密。
3. 进入页面的最早阶段捕获必要凭证到内存，立即 replaceState 清理，再初始化登录 SDK和任何遥测。
4. 保留公开 token/view 导航；粘贴完整凭证、扫码和开发用 proof 加载都通过同一校验入口。
5. legacy query 在首个 HTTP 请求时已到达服务端，前端清理不能撤销；CDN、反向代理、服务端及 APM 必须禁止记录敏感 query、完整 URL 和 Referer。
6. 配置 Referrer-Policy: no-referrer；API 禁止接受密钥字段，拒绝请求时也不记录原请求 body。
7. 签名属于可执行授权，虽不是私钥，也不写通用日志或分析平台。持久化只限受保护的任务表。

用合成 sentinel secret 验证浏览器网络、反向代理/API/APM 日志和数据库没有该值。对旧 query 的网络首跳做明确例外记录：它不可避免携带 secret，验收要求是 ingress 不记录、第三方请求不转发；若无法确认部署链路的日志配置，不宣称旧链接已满足无泄漏上线条件。

## 11. 按顺序执行

### M0：确认基线和服务配置

- 检查 Git 状态与指令，读取 PRD 和本文涉及的源码。
- 不覆盖其他未提交工作；按用户要求选择分支/工作区。
- 运行原有测试和构建，记录实际输出。
- 核实目标合约与系列：chainId、代码、claimProtocolVersion、serialRoot、供应量、开放状态和部署区块。
- 若尚未部署，先用本地 Hardhat 和合成凭证完成实现；不能编造 Sepolia 地址。

完成条件：明确哪些能力存在、哪些真实配置缺失，建立接口 schema 与配置检查。

### M1：登录和固定地址

- 接入 Privy、账户适配层、me API、钱包映射及退出清理。
- 新旧钱包入口共存，普通用户不见必填钱包地址/切链入口。
- 处理 SDK 加载失败、OTP 错误、过期会话和钱包创建未完成。
- 提供导出/恢复设置及必要的再次验证。

完成条件：跨设备恢复同一地址；伪造登录 token 和 recipient 被拒绝。

### M2：凭证处理和代付领取

- 升级 fragment/parser/bootstrap，再接代付接口。
- 建表、队列、worker、幂等、nonce、预留预算、receipt 对账。
- 前端展示排队、确认中、成功和可恢复错误。
- 外部钱包直接领取继续复用原授权逻辑。

完成条件：本地链完整零余额领取，且故障注入后不重复付款。

### M3：云花园

- 抽离共享纯规则，不把 React 或浏览器依赖带进后端。
- 实现服务端动作 API、并发版本、actionId 幂等和所有权校验。
- 接入云存储适配，保留游客花园。
- 明确旧存档策略，新增跨设备同步与账号切换测试。

完成条件：两台设备看到同一状态；并发收获仅奖励一次。

### M4：真实集成、交付

- 有配置时在 Sepolia 和实际登录服务完成验收；至少使用两个独立浏览器会话/设备。
- 浏览器自动化需要相应工具访问可用；访问被拒绝时记录阻塞，继续其他测试，不绕过限制。
- 更新 README、部署说明和 env 样例，提供迁移、worker启动、日志、预算及暂停说明。
- 依据本次任务的实际授权处理提交/推送/部署。不要把“完成代码”与“已上线”混写。

## 12. 必须通过的验收矩阵

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| A1 | 无插件、空余额、有效挂件 | 邮箱登录后领取成功，无手动切链/充值 |
| A2 | 登出后重登、另一设备登录 | 钱包地址相同，原宠物可见 |
| A3 | 伪造/过期/其他应用身份 token | 后端拒绝，不能建立钱包绑定 |
| A4 | recipient 改成另一地址 | 广播前拒绝，无 Gas 消耗 |
| A5 | 恢复设置/钱包导出 | 官方受保护流程，应用日志和后端无用户私钥 |
| C1 | 100 个同领取并发请求 | 一个 job、一个有效 nonce slot，参数冲突返回 409 |
| C2 | 多 worker、不同序号 | nonce 不冲突，预算原子限制有效 |
| C2b | 两 worker 同时竞争同一个 QUEUED job | 锁后重新检查，只分配一个未终结 nonce slot |
| C3 | 签署持久化后、广播前崩溃 | 重启广播原 raw tx，hash 相同 |
| C4 | 节点收到广播但返回超时 | 保持未决并对账，不换 nonce 重发新交易 |
| C5 | receipt 持续为空/短暂 RPC 失败 | 不误报失败，不生成重复领取 |
| C6 | 同 nonce 加速后旧 tx 先确认 | 识别旧 hash 的结果并结束任务 |
| C7 | 模拟重组 | 回退未达确认的结果，重新核验 canonical 区块 |
| C8 | 无效证明、过期授权、错误域、系列关闭 | 广播前拒绝 |
| C9 | 同一授权被第三方提交 | 根据 Claimed 事件核验归属，不误报丢失 |
| C10 | 余额不足、预算耗尽、关闭 relayer | 新广播暂停；已发交易继续跟踪 |
| C11 | 已领取后宠物被转移 | 区分初次领取结果和当前所有权 |
| G1 | 两设备同时收同一块地 | 仅一次奖励，另一请求同步最新状态 |
| G2 | 成功动作响应丢失再重试 | 相同 actionId 返回原结果，不再次扣费/奖励 |
| G3 | 伪造 XP、未来时间、完整 state | schema 拒绝，正式状态不受影响 |
| G4 | 账号切换或宠物转移 | 旧响应不污染新账号，旧主人不能继续云端写入 |
| G5 | 本机时钟前拨/回拨、离线重连 | 按服务端时间计算，无超时奖励和时钟作弊 |
| G6 | 读取花园/倒计时轮询 | 不凭空增加持久化 revision 或奖励 |
| G7 | 数据库状态损坏、规则版本不兼容 | 显式错误且保留记录，不静默重置或授予初始资源 |
| S1 | 含 sentinel 的新 fragment 链接 | secret 不进入 HTTP 请求、第三方遥测、日志或数据库 |
| S2 | legacy query 链接 | ingress 不记敏感 URL，清理早于 SDK 初始化 |
| R1 | 原有外部钱包、公开预览、动画和游客花园 | 原功能回归通过 |

自动化必须使用隔离数据库与合成凭证，不能拿真实用户挂件做破坏性重复领取。登录服务可在单元测试中 mock，但真实 OTP、恢复及跨设备验收必须单独执行并标注结果。

## 13. 检查命令和交付材料

当前仓库可用的基线命令：

~~~sh
npm ci
npm run test:unit
npm run contracts:compile
npx hardhat test --no-compile test/contracts.cjs
npm run build
git diff --check
~~~

Windows 环境若没有 npm/npx 入口，可在依赖已安装时调用：

~~~sh
node --test test/*.test.mjs tests/*.test.mjs
node scripts/compile-contracts.mjs
node node_modules/hardhat/internal/cli/cli.js test --no-compile test/contracts.cjs
node node_modules/vite/bin/vite.js build
~~~

以下脚本已存在于 package.json，修改相关功能后运行对应检查：

~~~text
npm run dev:server
npm run dev:worker
npm run db:migrate
npm run test:server
npm run test:integration
~~~

部署说明须包含 API/worker 启动、数据库迁移、合约和系列自检、登录域名、敏感日志、费用阈值、暂停和恢复。当前自动集成测试使用隔离 PGlite 内存库和 fake chain；真实 PostgreSQL 验收另建隔离测试库，不使用生产数据库。

回滚应先停新领取广播，保留并对账未决交易；回退 UI 不等于撤销链上交易。不可通过清空 job/nonce 表恢复服务。数据库迁移优先采用向后兼容的新增字段，明确备份与回滚条件。

最终交付报告至少写明：

- 修改文件与完成的 M0–M4。
- 实际测试命令、数量及结果。
- 本地模拟、真实身份服务、Sepolia、真实跨设备分别验收到了哪一层。
- 当前缺失配置和明确的阻塞项。
- 运行入口、账户恢复方式、代付范围和已知限制。
- Git 提交/PR/部署地址（仅在实际完成时提供）。

## 14. 可直接发给执行 Agent 的启动指令

~~~text
请在 GlowpetDapp 仓库执行 docs/AGENT_EXECUTION_PLAYBOOK.md。

目标：游客试玩 + 邮箱登录固定用户钱包 + 平台代付 v2 claim + 已领取宠物的跨设备云花园。
先读取文档、当前代码、仓库指令和 Git 状态，确认基线；按 M0 → M4 推进。
在接口和文件归属明确后，可把登录、代付、云花园并行分配给子 agent，
由主 agent 负责共享 schema、依赖锁文件、App 接线和完整验收。

复用现有领取合约和本地 credential 授权；用户钱包与挂件密钥必须分离。
实现身份校验、领取幂等、广播前持久化、nonce/预算并发控制和故障恢复。
云花园只接受动作，由服务器计算时间和奖励，不信任客户端快照。
保留游客、外部钱包、公开宠物与挂饰预览。

先完成不依赖真实配置的代码和测试，随后一次性列出所需服务配置。
不要虚构部署、OTP、浏览器或跨设备验收结果；mock 与真实验收分开报告。
缺少服务配置不应阻止可独立推进的工作。
提交、推送、付费服务和部署遵循当前用户授权与实际工具权限。
交付可运行实现、迁移、测试、配置样例和部署说明。
~~~

## 15. 官方参考与代码依据

以下服务能力已在 2026-10-24 查阅官方文档；实施时再次核对 SDK API 和版本兼容性。本文接口与数据库设计是 Glowpet 实施方案，不是供应商已提供的现成后端。

- [Privy 登录与身份方式](https://docs.privy.io/authentication/overview)：支持邮箱及 Passkey 等方式；账号认证同时关系到钱包访问。
- [Privy 创建用户钱包](https://docs.privy.io/wallets/wallets/create/create-a-wallet)：支持用户钱包创建及 React 登录时创建；需区分用户拥有和服务端拥有的钱包。
- [Privy access token 验证](https://docs.privy.io/authentication/user-authentication/access-tokens)：后端必须验证 token，不能信任客户端提供的用户标识。
- [Privy Node SDK 设置](https://docs.privy.io/basics/nodeJS-node/setup)：服务端 SDK 与 app secret 的配置入口。
- [Privy 钱包导出](https://docs.privy.io/wallets/wallets/export)：React 导出流程及创建环境限制；EOA 和智能账户导出语义不同。
- [Glowpet 合约](../contracts/Glowpet.sol)：claim 独立 recipient、签名域、serialClaimed、Claimed 事件和 onlyOwner evolve。
- [本地授权实现](../src/claim-authorization.js)：Merkle leaf、排序哈希和 EIP-712 字段以此与合约保持一致。
- [现有产品规划](PRD.md)：当前 MVP 与内嵌钱包、免 Gas、服务端里程碑之间的边界。
