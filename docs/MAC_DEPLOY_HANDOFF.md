# Mac 接手 Sepolia 与 EdgeOne 发布

交接基准：2026-11-06 21:28（Asia/Shanghai）。先读 [AGENT_HANDOFF.md](AGENT_HANDOFF.md)、[PROJECT_STATUS.md](PROJECT_STATUS.md) 和 [SEPOLIA_RELEASE.md](SEPOLIA_RELEASE.md)，再检查实际任务状态；本文件不是完成发布的证明。

## 2026-11-06 22:35 补记（Asia/Shanghai）

- 对原上传会话的 curl HEAD 已实际返回 200，确认偏移为 **980,172,992 / 10,496,885,603 字节**；Node fetch 的 HEAD 仍失败。本机 curl HEAD 适配器已审查，6 项守卫测试通过；沿原会话、同一输出记录的恢复任务于 **22:33:02** 启动，没有新建上传会话（无 POST）。**22:34:54 已观察到进度增长至 1,009,286,217 字节（约 9.6%）**，证明恢复后确实继续传输；这仍不是整包上传、持久 pin 或公开部署完成。
- 后台监控已于 **22:33:01** 实际启用，每 5 分钟检查，截止 **2026-11-07 04:33:01（Asia/Shanghai）**。仅在真实上传完成后推进两个独立网关的全量报告；两者各通过 10,001 文件核验后，才调用已审查并启用的 Git 白名单收尾脚本。当前正式发布和全量远端核验仍未完成。
- Mac 交接包与源码材料未变化；继续等待真实公开证据，不启动重复上传，也不将恢复任务或后台监控已启动记作 NFT 部署完成。此前时间点的记录保留如下。

## 2026-11-06 22:11 补记（Asia/Shanghai）

- 代码提交 **`403a1d6` 已推送 GitHub**。用户选择保留 Mac 项目在 `~/Downloads/dapp`，没有移动目录；远程 SSH 访问受到 macOS TCC 隐私保护限制，尚未验证该目录的原有素材。不要反复远程访问或绕过限制，由 Mac 本机 agent 接手核验。
- 另行传至 Mac 主目录下的私密交接包共 **13 个文件，已单独核验**；这不代表原项目或全部立绘已核验。领取材料和其他凭证未进入 Git，继续按交接包内说明私下保管。
- Windows 最后确认的上传偏移为 **965,969,207 / 10,496,885,603 字节（约 9.2%）**。传输因 HEAD 网络确认失败停滞，正在诊断与恢复；不能将旧的“已启动”状态理解为仍在成功传输，更不能视为已 pin 或已发布。Mac 不启动重复上传，不清空原状态，不编造完成结果。
- 后续只有真实发布成功、两个独立网关各完成 **10,001 文件、0 失败**核验后，才会生成公开结果 `docs/releases/deltax-unique-v2-sepolia-10000-ipfs.json` 并尝试安全同步 GitHub。Mac 更新代码后应先验证该文件的 `status=ipfs_verified_waiting_for_wallet`、既定 CID/清单/文件集、Pinata fileId 及完整网关证据，再将其中 `publication` 和 `verification` 对象原样保存为本机规范发布记录与核验报告。文件缺失或验证失败就继续等待，不能手填报告；钱包签名与前端发布仍是后续步骤。

## 两台设备如何分工

Windows 保持开机、联网和现有上传进程运行，继续正式 CAR 上传、Pinata 异步导入及两个独立网关的全量核验。Mac 先接收源码和必要材料，用户自己恢复 MetaMask；真实核验证据到齐后，Mac 才准备并签署 Sepolia 交易、构建和发布 NFT 前端。不要因为换机而停止 Windows、重建上传、清空状态或生成另一套领取凭证。

当前用户已确认 Pinata Picnic 生效。原 CAR 超过实测 TUS **10 GiB** 上限；无损去重后为 **10,496,885,603 字节**，全部 **10,001 文件**本地回读通过，根保持：

```text
bafybeiel5kxwyulqcsyd6tqb42scbs5ij57sn2yfj63w73spu2iwg7fqvm
```

正式上传开始于 **2026-11-06 21:28:44（Asia/Shanghai）**。本次版次的持久 pin、全量远端核验、链上交易、新版前端均尚未完成。小 CAR 已验证真实异步导入，但其成功不能替代正式版次证据。

## 1. 同步代码并准备环境

安装 Node.js **24** 和 Git，使用锁文件安装。新目录执行：

```sh
git clone https://github.com/YuxiangWangUF/GlowpetDapp.git
cd GlowpetDapp
git status --short --branch
git log -5 --oneline
node --version
npm ci
```

已有 checkout 先保存并审查本机改动，再 `git fetch origin`、核对交接提交后快进更新；不执行 reset 或覆盖。若远端名不同，以 `git remote -v` 为准。由 Windows agent 提供已推送的提交号，Mac 必须确认收到该提交；复制目录或看见旧首页不等于取得最新代码。不要复制旧机 `node_modules`，也不为方便安装而修改锁文件。

Git 不含冻结版次、领取材料、环境配置或上传状态。代码同步与这些材料的安全迁移是两件事。

## 2. 接收材料，保留来源

通过用户认可的本地或加密传输方式接收材料，传输前后核对文件清单与 SHA-256；不要将领取凭证放进 Git、公开链接、截图、聊天或静态站。

| 材料 | Mac 用途与要求 |
| --- | --- |
| `output/deltax-unique-v2-10000-sepolia-20261103/` | 准备器需要完整冻结版次，不能只拿缩略图或 collection。保留原 PNG 和清单，不重新渲染。 |
| 当前实际部署系列的公开 `series.json` | 与当前私密领取材料属于同一系列；核对 chain ID 11155111、supply 10000、root、系列 ID 和版次。不要误用 11/03 的历史准备材料代替 Windows 当前选择。 |
| 该系列原始 seed、领取凭证和 proof 导出 | 只进入受保护且 Git 忽略的目录。保留对应关系，不重新随机生成；公开 `series.json` 无法恢复私密领取材料。 |
| 最终发布记录、双网关完整核验报告 | 等 Windows 真正生成后再传输；旧草稿、本地回读报告和小探针报告不能充当正式远端证据。 |
| 交易计划与成功回执 | 核验后保留；新设备签名前重新读 nonce 和费用，过期计划须另存新文件重建。 |
| `.glowpet-local-demo/package-public-nft-edgeone.mjs` 及公开路径配置 | 这是当前本机 NFT 专用打包入口，不随 Git 同步，须另行接收。配置 `public-release-panel-config.json` 只保留公开路径/RPC，将路径改成 Mac 实际位置，不复制上传状态或凭证。 |

冻结清单 `publish/collection.json` 的预期 SHA-256：

```text
a5d3e62f25018c4692043cca0f014780f297b0feb29640a10af073c772717a54
```

macOS 可用 `shasum -a 256 <文件>` 对照受保护的传输清单。JWT、上传会话 URL、Windows 本机代理配置和运行日志留在 Windows，不需要给 Mac 签名或前端构建使用。任何 `VITE_*` 值都会进入浏览器，不得放 secret。

## 3. 等待正式上传与核验证据

Windows 当前输出记录为 `deployments/sepolia-10000-20261106-Gbkt3e/ipfs-publish-deduplicated.json`；对应状态在 Windows 原位置保留。Mac 不运行第二个 `ipfs-publish`，也不删除锁或未知会话来“重试”。Windows 重启或中断时，由负责该任务的 agent 按原 CAR、草稿、同一输出记录恢复。

进入签名前，实际证据必须同时满足：

- Pinata 文件记录已确认是上述内部目录根，而不是末块 `upload-cid` 的外层 CAR 临时 CID。
- 两个独立运营的网关都已下载并核验全部 **10,001 文件**，`failedFiles=0`，清单和文件集哈希与本地冻结版次一致。
- 发布记录、核验报告及系列材料属于本次正式版次；不得手工填成功计数、`pinned` 或 CID。

`ipfs.io` / `dweb.link` 已退役普通 HTTP 网关，不能沿用旧双网关例子，见 [官方迁移说明](https://gatewaychanges.ipfs.io/)。当前 Pinata 专用网关与 `https://ipfs.filebase.io` 只完成小样本验证，正式全量结果仍需 Windows 任务提供。

## 4. 用户恢复钱包，Mac 准备并签署

由用户本人在 Mac 安装或登录官方 MetaMask，并自行恢复钱包。agent 不索取、读取或转移助记词、私钥和钱包密码。核对当前公开地址与系列/计划中部署者一致，网络为 **Sepolia 11155111**；余额、pending nonce 和费用在签名前现场确认。

按 [Sepolia 发布手册](SEPOLIA_RELEASE.md) 使用完整冻结清单、当前 `series.json`、真实 CID 和正式双网关报告运行准备器，输出新的未签名计划。若 Windows 绝对路径不适用，应在 Mac 以实际文件路径重新运行准备器；不要改证据字段来绕过检查。

用户依次核对并签署部署和 `createSeries`：先等部署回执成功、地址与构造参数读回匹配，再重新核对 nonce 并创建系列。最后读回系列 root、supply、open、`minted=0`，记录真实合约地址、部署区块和交易哈希。不要运行 `deploy-local.mjs`，其钱包和配置属于本地演示。

## 5. 构建并发布 NFT 前端

只有真实合约和系列核验完成后才配置发布。使用已核验的新 Glowpet 主合约地址、series ID、部署区块、可用 Sepolia RPC 及有效 HTTPS IPFS 网关。邮箱登录、代付和云存档未验收时保持 `VITE_AUTH_MODE=off`；`VITE_PROOF_BASE_URL` 留空，不能把正式 proof 目录作为静态资源发布。

**不要用 `npm run build:visitor` 或默认 `npm run release:edgeone` 发布 NFT 版本。** 这两个游客入口会清空合约地址；即使先填写了正确环境，也可能得到游客包。

当前已准备独立入口 `.glowpet-local-demo/package-public-nft-edgeone.mjs`，须随受保护交接材料迁移到 Mac 仓库相同相对位置。它读取同目录 `public-release-panel-config.json` 中的公开 `root`、`releaseDirectory`、`manifest` 和 `rpc`；前三项替换为 Mac 的真实路径。签名后的 `signing-state.json`、发布计划、当前系列、真实发布记录、双网关报告均须在匹配的部署目录中。正式上传结果文件名与入口期望文件名须先核对一致；只能引用真实记录，不能手写占位 JSON。

两笔真实交易成功后，先检查，再打包：

```sh
# GLOWPET_VERIFIED_GATEWAY 是已完成正式全量核验的公开 HTTPS 网关基址
node .glowpet-local-demo/package-public-nft-edgeone.mjs \
  --gateway "$GLOWPET_VERIFIED_GATEWAY" --check-only

node .glowpet-local-demo/package-public-nft-edgeone.mjs \
  --gateway "$GLOWPET_VERIFIED_GATEWAY"
```

该入口会重新查询真实 Sepolia 回执及合约/系列参数，检查 IPFS 证据与网关，生成新的 `Glowpet-Sepolia-EdgeOne.zip` 和清单；不会上传、改 DNS 或读取 JWT、领取 seed、proof。无签名或证据不齐时拒绝打包。入口缺失、脚本检查失败或尚未验收 Mac 运行结果时，继续修复具体问题，不以游客 ZIP 代替。

上传前本地预览实际产物，确认打包保留正确合约、系列、网关，真实链上读取正常；领取材料、env、源码、私密状态均不在 ZIP。ZIP 根目录应包含 `index.html` 与有效的 `edgeone.json`。用户自行登录现有腾讯云 EdgeOne 项目，发布核验后的包，再检查实际站点、手机访问、链上图片和游客功能。构建成功、EdgeOne 上传成功和实际网站验收分别记录。

本次交接不恢复 DNS 迁移、ICP 备案或新增购买。用户尚未作出的真实钱包签名不能由 agent 宣称完成；最终报告必须区分上传、远端核验、链上部署、系列创建与前端发布各自的实际结果。
