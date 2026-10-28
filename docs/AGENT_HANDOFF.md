# Glowpet 跨设备交接手册

更新日期：2026-10-28（Asia/Shanghai）。仓库：<https://github.com/YuxiangWangUF/GlowpetDapp>。

本手册用于在新设备接手当前代码、素材和待办。先运行游客版，再按具体任务启用本地后端或合约。Git 提交记录是代码版本依据；运行中的进程、浏览器存档、平台账号和私密配置不会随 `git clone` 迁移。

用户当前决定：**备案和域名迁移暂缓，先同步 GitHub、换设备继续开发。** 不要把先前的发布步骤当作本轮重新部署、购买云资源或提交备案的指令。

## 1. 接手后的第一轮

1. 读取根目录 `AGENTS.md`、本手册、[README](../README.md) 和相关专题文档，检查 `git status --short --branch`、`git log -5 --oneline`、`git remote -v`。
2. 保留已有改动，确认当前 checkout 和用户要推进的任务。不要执行清理、重置或覆盖私密环境文件来获得“干净基线”。
3. 按下一节启动首页和游客花园，确认五种宠物、新首页猫专属醒狮帽及基本花园操作。
4. 根据任务运行第 7 节对应检查；记录当前环境的实际结果，不能将本手册的历史记录当成新设备验收。
5. 需要真实身份、链或部署时，先核实对应配置和服务状态，再执行相关步骤。只报告已经观察或验证的结果。

专题入口：

| 任务 | 先读 |
| --- | --- |
| 游客首页、花园、角色展示 | `src/App.jsx`、`src/GardenView.jsx`、`src/HomePortraitShowcase.jsx` |
| 独特外观、冻结图片、DeltaX 合约 | [DELTAX_NFT_ART.md](DELTAX_NFT_ART.md) |
| 邮箱账号、代付、云花园 | [ONBOARDING_DEPLOYMENT.md](ONBOARDING_DEPLOYMENT.md)；[AGENT_EXECUTION_PLAYBOOK.md](AGENT_EXECUTION_PLAYBOOK.md) 是实现约束与验收规格 |

## 2. 新设备先跑游客版

安装 Git 和带 npm 的 Node.js 24。统一使用 Node 24，与当前后端、测试及已验证的开发环境保持一致。依赖以 `package-lock.json` 为准，不复制旧设备的 `node_modules`，也不顺带升级锁文件。

```sh
git clone https://github.com/YuxiangWangUF/GlowpetDapp.git
cd GlowpetDapp
node --version
npm ci
npm run dev -- --host 127.0.0.1
```

打开终端实际显示的地址，通常为：

- 首页：`http://127.0.0.1:5173/?view=home`
- 游客花园：`http://127.0.0.1:5173/?view=garden`

干净克隆没有本机 env 时，默认 `VITE_AUTH_MODE=off`、合约地址为空，可以直接试玩，无需钱包、数据库、Privy 或本地链。若机器上曾运行全栈 demo，检查是否有旧 `.env.development.local` 将开发模式改为 `mock`；保留并备份文件，再按本次任务选择配置。

游客发布已有跨平台安全入口，优先执行：

```sh
npm run build:visitor
npm run release:edgeone
```

`build:visitor` 由 `scripts/build-visitor.mjs` 固定游客公开配置，构建 `dist/`。`release:edgeone` 由 `scripts/package-edgeone.mjs` 先执行游客构建，再使用 `hosting/edgeone.json` 生成可直接上传的 ZIP；输出在被 Git 忽略的 `output/releases/` 新目录，不依赖系统 tar/Python，也不上传、不修改 DNS。终端会给出实际产物位置和校验信息。

若需理解或手动配置等价的公开环境，游客版采用以下值；不要套用全栈 demo 的 env：

```env
VITE_AUTH_MODE=off
VITE_PRIVY_APP_ID=
VITE_GLOWPET_ADDRESS=
VITE_PROOF_BASE_URL=
VITE_API_BASE_URL=/api/v1
VITE_GLOWPET_SERIES_ID=1
VITE_DEPLOY_BLOCK=0
VITE_SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
```

构建后运行 `npm run preview -- --host 127.0.0.1`，以终端实际端口验收 `dist/`。普通 `npm run build` 按自身环境构建，不会替你切换游客配置；`VITE_*` 都会进入浏览器，不能放入私钥或服务端 secret。`mock` 身份只允许本地开发，生产构建会拒绝它。

旧设备的 PowerShell 曾出现 CET 启动故障，因此当时用 `cmd.exe` 执行命令；这是旧机问题，不是新设备的必备配置。新设备正常安装 Node/npm 后优先使用上述 npm 命令，不照抄旧机程序路径或代理端口。

## 3. 当前功能边界

| 模块 | 已有实现 | 尚未完成的真实上线环节 |
| --- | --- | --- |
| 公开游客版 | 首页、五种角色、v2 完整立绘预览、浏览器本地花园、领取未开放提示 | 大陆手机网络的稳定正式域名访问仍待处理 |
| 邮箱账号和内嵌钱包 | `src/auth/` 的 Privy 适配、mock、固定 EOA 地址绑定和账户 UI | 真实 Privy app、邮件 OTP、恢复/导出、独立设备验收 |
| 代付领取 | API、队列、幂等、nonce/预算预留、广播前持久化、回执对账 | 正式 PostgreSQL、隔离 relayer、真实 Sepolia 合约/系列及运营配置 |
| 云花园 | 服务端动作校验、时间、revision、幂等、链上所有权检查、前端同步 | 正式服务部署、真实账号和两台物理设备验收 |
| DeltaX NFT | v2 组合规则、100 张完整 PNG、核验器、元数据及合约接线 | IPFS 持久 pin、远端核验、新合约目标网部署、真实领取 |
| 其他 | 原外部钱包与旧 SVG 合约流程仍保留 | BLE 实物连接、自动链上进化、钱包通用代付未交付 |

线上范围只获准开放游客版。代码存在不代表邮箱账号、NFT 领取和云端存档已在公网提供。PGlite/mock/本地链成功不等于真实 Privy、Sepolia 或生产数据库验收。

链上 `evolve` 仍由合约 owner 调用，云端 XP 不自动改变链上 Stage。代付范围是 `claim`，不包含 ERC-721 转移等其他交易。后台没有自动提价替换交易功能；卡住的 nonce 要对账，不能清空任务表“重试”。

## 4. 宠物形象与冻结版次

当前规则为 **`deltax-unique-v2`**，渲染器为 `deltax-chinese-wardrobe-v2`。五种基础角色为兔、猫、狐、鼠、羊。

- 七类头饰适用于全部五种角色；**醒狮帽只给小猫**，使用用户批准的红金白毛绒醒狮猫原图 `public/pets/deltax-wardrobe-v2/cat-lion-cap.png`。帽子保留原色，颈饰仍按组合变化。
- 有效组合数为 **18,432 = (5 × 7 + 1) × 8 × 8 × 8**。图片编号仍使用 0–20,479 的稀疏子集；不能把最大图片编号当作有效容量。
- 唯一性限于同一个合约版次内预留的全部系列，不承诺跨部署或全球唯一；外观不随领取顺序、钱包、转让或成长改变。
- 游客花园仍用 `public/pets/deltax-soft-v1/` 五张基础图。首页用 `public/pets/deltax-unique-v2/` 的完整组合 WebP；修改首页图片不会改动链上 NFT。
- NFT 最终 PNG 计划保存在 IPFS，链上保存所有权、分配规则和元数据，不能称为“全部像素上链”。

当前已核验 100 张版次位于 `output/deltax-unique-v2/`，公开发布内容为其中 `publish/`；清单 SHA-256：

```text
006de3c5b4c2627498b349fc04b3150c0b7fc729c760c64564efe599acfbfeec
```

```sh
npm run art:verify
```

核验检查规则和渲染器源码、原图、Sharp/libvips 版本、文件与像素 hash、属性和去重。冻结清单有问题时应调查，不直接改 hash 来让核验通过。跨平台原生图像依赖可能不同；保留已有批准 PNG，报告不一致后再决定新版本，不能在新设备悄悄重渲染旧版次。

默认 `npm run art:generate` 会拒绝覆盖现有目录。要做新的实验输出，明确使用新目录，例如：

```sh
node scripts/generate-deltax-edition.mjs --out output/deltax-experiment --supply 100
```

`output/deltax-unique-v1/` 是历史版次；不要用 v2 规则去修补其冻结清单。美术规则的详细维度、CID 和发行流程以 [DELTAX_NFT_ART.md](DELTAX_NFT_ART.md) 为准。

## 5. 可选本地全栈 demo

仅在需要账号、领取或云花园开发时启用。此路径会生成本机配置和公开的 Hardhat 测试钱包，只能运行在本地测试网络。

先在新克隆中执行：

```sh
npm run contracts:compile
npm run local:node
```

让该终端继续运行。这个 Hardhat 节点的 chain ID 特意设为 `11155111`，但 RPC 是 `http://127.0.0.1:8545`，不是公网 Sepolia。在第二个终端的仓库根目录逐条执行：

```sh
npm run serials -- --supply 3 --chain-id 11155111 --series 1 --out .glowpet-demo --split 1-3 --split-dir .glowpet-demo/proofs
npm run local:deploy
```

仅对新 demo 目录这样生成；已有 `.glowpet-demo` 或正式凭证必须保留，不能删除后重建来迎合旧 root。`local:deploy` 会覆盖 `server/.env`、`.env.development.local`，因此仅在新克隆或已备份且明确要切换为 demo 的配置中运行。脚本可能在终端显示合成领取链接，分享日志时不要照搬其中的 secret。

再开两个终端，分别启动：

```sh
npm run dev:server
```

```sh
npm run dev -- --host 127.0.0.1
```

本地 demo 使用 `AUTH_MODE=mock`、`DATABASE_URL=pglite:memory` 和 `RUN_WORKER_IN_API=true`；**不要再单独启动 worker**。PGlite 内存库随 API 重启清空。本机链重启也会丢失测试链状态，旧合约地址和旧领取结果不能继续当作存在。

可用 `alice@example.com` 测试 mock 登录，从 `.glowpet-demo/proofs/1.json` 取合成 `claimUrl` 在本机打开。第二个浏览器会话可检查同一 mock 账户，但这不证明真实邮箱或设备恢复可用。

默认 `local:deploy` 没有 `DELTAX_ART_CID` 时使用旧 SVG 合约。只有实际上传且已核验的 IPFS CID 才能切入 DeltaX；不能编造 CID 来让 demo 看起来已发布新版 NFT。

真实 PostgreSQL 模式才按 [ONBOARDING_DEPLOYMENT.md](ONBOARDING_DEPLOYMENT.md) 配置 `DATABASE_URL`，执行 `npm run db:migrate`，再分别启动 `npm run dev:server` 与 `npm run dev:worker`。生产中关闭 mock，费用上限与专用 relayer 未完整配置前保持代付暂停。

## 6. Git 之外需要安全迁移的内容

| 内容 | 迁移方式与边界 |
| --- | --- |
| `.env`、`.env.local`、`.env.development.local`、`.env.production.local`、`server/.env` | 不进 Git。新设备依据样例重新配置；确需旧值时使用用户自己的安全传输方式，不能粘贴到公开 issue、聊天、手册或日志。前后端 secret 分开。 |
| 正式领取 seed、proof 导出、`.glowpet-demo/`、`deployments/` | 都可能包含可直接领取宠物的 bearer 凭证，不能上传。已有链上系列要保留与 root 匹配的原始凭证，不能靠重新随机生成恢复。新机本地 demo 可另建合成数据。 |
| 数据库和未决交易 | 有持久服务时做受保护的备份，保留 job、attempt、nonce slot 和预算状态。不要把数据库内容放到仓库；PGlite 内存 demo 没有可恢复的持久数据。 |
| 游客花园 | 保存于原浏览器 `localStorage`，Git 不包含它。需要保留时只导出对应花园 JSON 和选角偏好，私下传输后在正确 origin 恢复，不批量复制身份 token、整个浏览器配置或所有 storage。 |
| Codex、GitHub、腾讯云、Privy 等平台登录 | 在新设备按官方流程登录授权。仓库不包含登录态，也不复制或输出 Codex 凭据文件。 |
| 一次性打包 ZIP、截图、临时日志 | 根据需要另行复制，优先从源码与锁定素材重建；不能把旧发布包当成比仓库源码更新的事实来源。 |

游客花园 key 是 `glowpet:garden:v1:guest`，选角偏好 key 是 `glowpet:preview:deltax-soft-v1`。链上宠物的本机花园 key 还包含 chain、contract、token 和 owner。存档按协议、域名、端口隔离；`localhost`、`127.0.0.1`、正式域名、测试子域名之间不会自动共享。确认 origin 后再恢复，避免误以为存档丢失。

所有 `VITE_*` 均是公开前端配置；服务端密钥、钱包私钥和领取 secret 不能放进去。不要将旧机的 `node_modules/`、本地日志、嵌套 Sites 仓库 `.git/` 或任何实际 `.env` 当作迁移资料加入提交。

## 7. 检查命令与验收层次

在仓库根目录按顺序执行：

```sh
npm run test:unit
npm run test:contracts
npm run test:server
npm run art:verify
npm run build:visitor
git diff --check
```

`test:contracts` 会先编译再运行 Hardhat 隔离测试，不需要连接正式链。`test:server` 内的集成测试用 PGlite 内存库和 fake chain，不依赖正在运行的本地 RPC，也不证明真实 PostgreSQL、Privy 或 Sepolia 可用。`test:integration` 是其中 API/数据库集成套件的单独入口，不要将与 `test:server` 重复运行的用例相加为新增覆盖。

旧设备 2026-10-28 的本轮交接验证：前端/共享单元测试 **89 项**、合约 **22 项**、服务端 **19 项**，合计 **130 项全部通过**。合约编译、v2 100 图核验、游客版 production build、公开凭证审计和 EdgeOne 本地打包也通过。测试结果只覆盖相应的本地自动检查，不代表真实 Privy、Sepolia、生产服务或新设备验收。

依赖已经安装但旧机 npm/npx 启动入口不可用时，可用以下等价入口排查；它们不是替代新机正确安装 npm 的长期方案：

```sh
node --test test/*.test.mjs tests/*.test.mjs
node scripts/compile-contracts.mjs
node node_modules/hardhat/internal/cli/cli.js test --no-compile test/contracts.cjs
node --test server/test/*.test.mjs
node node_modules/vite/bin/vite.js build
```

## 8. 托管与域名的真实状态

| 地址或服务 | 当前记录 |
| --- | --- |
| `https://glowpetscharm.com` | 仍指向此前的 Sites 公共游客站。已复现部分直连网络的 Cloudflare 403；换网络出口能返回正常页面，不能据此称大陆手机访问已修复。 |
| `https://glowpetscharm.quickape14.chatgpt.site` | 原 Sites 托管地址，项目 ID 为 `appgprj_6add0caf5a9c81918776c5719355ae02`。如后续确需维护原站，复用该 ID，不另建同名站。 |
| `https://glowpets-ort06io2.edgeone.cool/` | 用户已将游客包部署至腾讯云 EdgeOne Makers。已读到 Glowpet HTML；其项目区域由用户确认为“全球可用区（含中国大陆）”，未备案域名添加被平台拒绝。 |
| Makers 默认预览链接 | 中国大陆访问使用含 `eo_token`、`eo_time` 的临时链接，官方说明有效 3 小时。不要将签名参数写进仓库，也不要把临时预览当正式访问入口。 |
| `preview.glowpetscharm.com` | 只是先行验证方案，目前没有已绑定、已解析成功的记录。 |
| DNS 和备案 | DNSPod；本轮尚未切换主域名解析，用户已决定暂缓备案和迁移，没有提交备案或购买云资源。 |

旧 Sites 发布的是独立静态产物 checkout，不等于源项目主仓库。旧机的 `sites/glowpetscharm`、平台写入凭证及执行进程不必在新机原样复原才能开发。

恢复托管任务时先向用户确认其最新平台状态，再读取实际区域、自定义域名、证书和 CNAME；不能猜解析值。官方规则允许未备案域名接入“全球可用区（不含中国大陆）”，含大陆节点则需备案。现有项目没有已确认的区域修改路径；若用户选择境外区域方案，文档支持的路径是新建相应区域的直接上传项目。

Makers 的 `_headers` 兼容性不能照搬 Netlify/Cloudflare Pages。使用 `npm run release:edgeone` 会通过 `hosting/edgeone.json` 将安全响应头放在 ZIP 根目录的 `edgeone.json` 中，最外层也包含 `index.html`。只有实际完成新托管域名与手机流量/Wi-Fi 验收后，才安排主域名切换。

参考：[Makers 区域和域名](https://cloud.tencent.com/document/product/1552/127403)、[直接上传](https://pages.edgeone.ai/zh/document/direct-upload)。平台规则可能更新，恢复此任务时再核实。

## 9. 后续工作顺序

1. **换机基线**：游客版可运行、当前代码和素材齐全、适用测试通过。修复明确复现的问题，不借交接重做架构或升级依赖。
2. **按用户新任务推进产品**：保持五种角色和猫专属醒狮帽的批准边界；改动后核验视觉与素材引用。
3. **账号正式接入**：等用户提供真实 Privy、PostgreSQL、Sepolia 与 relayer 配置，按部署说明执行。补齐真实 OTP、恢复/导出、跨设备钱包与云花园验收。
4. **NFT 发行准备**：核验批准版次、实际 IPFS 持久 pin 和下载比对，再安排目标网络部署、系列 root 与真实领取，不把本地导出当已发行。
5. **用户恢复域名任务后**：确认选择备案还是境外节点；使用实际托管记录和证书，先测试后切换 DNS。当前暂不主动推进备案、购买或再发布。

## 10. 可交给下一位 agent 的开场指令

```text
请接手 GlowpetDapp。先读 AGENTS.md、docs/AGENT_HANDOFF.md 和相关专题文档，检查 Git 状态并保留已有工作。
先在本机运行首页与游客花园，再按我接下来的任务推进，并运行与改动相符的检查。
当前公开版只有游客功能；真实邮箱账号、代付、云存档和新版 NFT 尚未正式上线。
外观规则为 deltax-unique-v2，有效组合 18,432，醒狮帽仅供小猫，沿用已批准毛绒版本。
备案和域名迁移暂缓。不要主动购买、提交备案或重发网站；需要恢复此项时先核对最新平台状态。
私密环境、领取凭证与浏览器游客存档不在 Git，缺少真实配置时先完成不依赖它的工作。
报告本次实际修改、测试结果、仍缺的配置和验证，不把 mock、本地链或历史记录当成生产验收。
```
