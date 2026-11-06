# Sepolia 10,000 只版次发布材料

目标网络为 **Sepolia（11155111）**，版次和领取系列上限为 **10,000**；部署及创建系列后已铸造数量为 **0**。每次成功领取才铸造一个 NFT。公开的美术种子不是领取凭证种子。

本轮状态更新于 **2026-11-06 21:28（Asia/Shanghai）**：一万张新版次已完成本地核验，正式去重 CAR 于 **21:28:44（13:28:44 UTC）** 开始上传。当前正式版次的持久 pin、全量远端核验、公开链上交易及新版 NFT 前端发布均未完成。没有真实远端核验记录时，不能生成可提交的部署交易，也不能宣称已发布。原 `output/deltax-unique-v2/` 的 100 张冻结版次、原大 CAR 和新版冻结文件全部保留。

## 本地准备

使用 Node.js 24 和已锁定依赖。新领取凭证由 `scripts/build-serials.mjs` 生成在独立的 `deployments/` 目录；整个目录可能包含私密 seed 和 proofs，不上传、不同步 Git。

完成一万张图和公开 `series.json` 后，在本机将 `DEPLOYER_ADDRESS` 设置为 MetaMask 中当前确认的**公开地址**，再运行：

```sh
node scripts/prepare-sepolia-release.mjs \
  --manifest output/deltax-unique-v2-10000-sepolia-20261103/publish/collection.json \
  --series deployments/sepolia-10000-20261103/series.json \
  --from "$DEPLOYER_ADDRESS" \
  --out deployments/sepolia-10000-20261103/release-plan.json
```

脚本重新核验完整图片、规则、像素去重和文件校验和，检查系列是 Sepolia v2 且有 10,000 个叶节点。输出 `status: ready_for_ipfs`、`directoryCID: null`、`transactions: null`；没有占位 CID 或可意外广播的 calldata。输出使用 `wx`，拒绝覆盖已有计划。计划记录当前公开钱包地址，真正签名前需再次核对。

脚本不会读取 `.env`、钱包私钥或私密领取凭证，不连接 RPC、不签名、不发送交易。它只接受公开 `series.json`，会拒绝含 `secret`、`seed`、`proof` 等私密字段的输入。

## IPFS 完成后

用户已确认当前 **Pinata Picnic** 套餐生效。2026-11-06 对 TUS 上传端点的 OPTIONS 实测返回 `Tus-Max-Size: 10737418240`，即 **10 GiB**。套餐存储容量和通用上传文档不能代替这个实际单次限制；原 12,767,137,078 字节 CAR 超限，当前 10,496,885,603 字节去重包低于限制。凭证只放在进程内存或 shell 环境变量 `PINATA_JWT`，不写入任何文件或 `.env`。

本次正在运行的输出记录为 `deployments/sepolia-10000-20261106-Gbkt3e/ipfs-publish-deduplicated.json`，对应 CAR、草稿和本地回读报告位于同目录的 `deduplicated-car-20261106-yFq5uL/`。先检查现有任务是否仍运行；下面是通用命令说明，不是要求启动第二个任务。恢复去重包时继续使用该输出记录及其状态，不能套用原包的失败状态。

三个步骤都由仓库脚本完成，CID 全部在本地计算，上传结果必须与本地根一致：

```sh
# 1. 只打包、不上传：得到目录 CID 并检查目录结构，不需要账号
node scripts/ipfs-publish.mjs \
  --dir output/deltax-unique-v2-10000-sepolia-20261103/publish \
  --out deployments/sepolia-10000-20261103/ipfs-publish-draft.json --dry-run

# 2. 确认无同一任务运行后，复用匹配草稿的 CAR（磁盘分块 TUS，car=true）
PINATA_JWT=... node scripts/ipfs-publish.mjs \
  --dir output/deltax-unique-v2-10000-sepolia-20261103/publish \
  --car deployments/sepolia-10000-20261103/edition.car \
  --reuse-car deployments/sepolia-10000-20261103/ipfs-publish-draft.json \
  --keep-car \
  --out deployments/sepolia-10000-20261103/ipfs-publish.json

# 3. 两个独立网关全量下载校验，生成可用作 --ipfs-report 的证据
PINATA_JWT=... node scripts/ipfs-verify.mjs \
  --dir output/deltax-unique-v2-10000-sepolia-20261103/publish \
  --cid bafy... \
  --publish-record deployments/sepolia-10000-20261103/ipfs-publish.json \
  --gateway https://<专用网关>.mypinata.cloud --gateway https://ipfs.filebase.io \
  --out deployments/sepolia-10000-20261103/ipfs-verification.json
```

`--reuse-car` 接受 `packed_not_uploaded` 草稿，必须同时传入原始 `--car` 路径。脚本重新核验当前图片清单、CAR 大小和 SHA-256、唯一根、所有块的 CID，以及从根目录实际导出的全部 10,001 个文件。支持宽目录的 HAMT 分片，内存中只存块偏移索引，图片按流哈希。复用的 CAR 始终保留。新打包使用独占创建，已有 CAR 会报错，避免覆盖已核验档案。加上 `--dry-run` 可单独执行该回读流程。

新打包会按 CID 去除重复块记录，内存只保存已见 CID 集合，原块字节直接写入 CAR，并保留输入 DAG 的根。两个不同文件可以共享部分块，因此该步骤同时保留所有文件及其原始内容。已经保存的 CAR 和草稿仍是独立来源记录，派生去重包写入新路径并重新计算 CAR SHA-256、执行全量文件回读。此次去重包为 **10,496,885,603 字节**，保留原根 `bafybeiel5kxwyulqcsyd6tqb42scbs5ij57sn2yfj63w73spu2iwg7fqvm` 及 22,882 个唯一块，低于实际 TUS 10 GiB 上限；全部 **10,001 文件回读通过**。新 CAR SHA-256 为 `db57c42e1f6c46f35b12a4eaf5318adcfdfd4015cac7c8630dd15ffe19b4a9f2`，冻结图片和清单未变。

正式上传使用 `scripts/ipfs-tus.mjs` 从磁盘按完整文件偏移读取 16 MiB 分块。Node 24.16 的本机 `fs.openAsBlob` 在 12,767,137,078 字节 CAR 上实测返回了 4,177,202,486 的截断长度，因此大文件上传入口全部采用 `fs.stat` 与 `FileHandle.read`，长度和偏移使用安全整数。回归测试使用真实大于 4 GiB 的稀疏文件，验证跨 2^32 位置读取及请求长度。普通分块 413 可在 HEAD 对账后降低到 1 MiB，明确整包大小拒绝时立即停止并保留脱敏原因。

TUS 创建请求前先保存阶段，收到 Location 后立刻持久化，再传输字节。每个成功分块记录服务端确认的偏移，网络错误或 409 时用 HEAD 对账后继续。`<out>.state.json` 含 TUS URL，按私密运行状态保存，避免输出到聊天或提交 Git。上传中断后重跑相同命令、相同 `--out` 会重新核验 CAR 并从服务端确认的偏移恢复。已完成传输的状态直接等待公开文件索引，避免对已过期 TUS 资源重复提交。

Pinata 的 CAR 导入是异步的，最终 PATCH 可以没有 `fileId`。脚本保存完整传输回执后，通过准确 CID 和文件名称查询 Files，找到 ID 时先落盘，再确认公开文件记录的 ID 和完整 CID。默认等待 30 分钟，可用 `--wait-ms` 调整。查询确认后输出的状态仍为 `uploaded_pending_remote_verification`，实际远端可用性由第三步双网关全量检查确认。官方规则见 [CAR 上传与异步处理](https://docs.pinata.cloud/files/uploading-files)。

一个从未上传过的 535 字节小 CAR 已完成真实 TUS 探针：末块 `upload-cid` 先指向外层 CAR 文件，约 **14 秒**后公开 Files 出现内部目录根，两个公网文件路径的内容均与原文件匹配。该 header 只作临时传输诊断保存，最终正确性由 Files 的准确根 CID 与后续文件下载核验确定。服务端确认末块 `Upload-Offset` 等于完整文件长度且回执已落盘后，直接等待导入，避免导入期间清理 TUS URL 导致额外 HEAD 404 推翻已完成的传输。小探针的成功不代表正在上传的正式版次已经导入。

超时或临时查询失败后，重跑**相同命令、相同 `--out`** 会继续查已保存的 `fileId`。若旧上传器或创建请求未留下 Location，必须先只读检查账户。取得目标文件 ID 后可追加 `--resume-file-id <ID>`。明确决定重启未知会话时使用 `--restart-untracked-upload`，脚本会重新分页查询目标 CID、准确名称与 pending 项。已有目标根则复用其 ID，发现其他相关项则停止，三组结果都空时才保留旧阶段到 `recoveryHistory` 并创建新会话。Files 列表无法排除未列出的半成品 TUS 会话，因此该选项代表明确的恢复决定，不应加入通用自动重试循环。不会删除旧远端资源。

同一输出路径由 `<out>.lock` 独占，正常退出会释放锁。进程被强制结束时，先检查锁中记录的 PID，确认该进程已结束，再只移除这个锁并重试。状态文件和最终记录采用临时文件落盘后原子发布，均不保存 JWT。输出记录已存在时脚本停止，避免重复提交。请保留与本次上传对应的草稿、状态文件和发布记录，等待双网关检查完成。

若已保存的 TUS Location 在 HEAD 中返回 404 或 410，可明确使用 `--restart-expired-upload`。脚本会实时复查该 URL，只有确认失效并再次完成上述三组账户审计后，才归档旧会话并创建新会话。成功 HEAD、认证失败、限流或服务错误均不触发重建。使用相同 `--out` 保留全部恢复记录和同一份 CAR。

2026-11-06 原 12,767,137,078 字节 CAR 的首块 PATCH 曾返回 HTTP 413，服务端明确提示 `Upload-Length exceeds maximum upload size`，该失败会话确认接受的 CAR 字节数为 0。已用 OPTIONS 的 10 GiB 实际上限定位原因，并以保持原根的无损去重包解决本次长度问题。遇到新的明确整包大小拒绝时，上传器仍会保留脱敏原因并立即停止，避免随后失效会话的 HEAD 404 覆盖根因；不能盲目缩小分块来规避总长限制。

校验脚本会先向 Pinata 复核记录中的文件仍解析到该 CID（`pinned` 只能由这次复核置为 true），再下载并比对全部文件哈希；中断后重跑会复用已校验文件。两个网关必须独立运营且主机名不同。`ipfs.io` 和 `dweb.link` 已停止普通 HTTP 网关服务，实测返回退役提示，不能继续作为默认双网关候选，见 [官方迁移说明](https://gatewaychanges.ipfs.io/)。

当前候选为 Pinata 专用网关与 `https://ipfs.filebase.io`。两者已对同一小样本实际返回完整 CAR，并逐块、逐路径核对两文件内容通过；远端 CAR 的块顺序可以与本地不同，不能仅以容器 SHA-256 不同判断内容错误。**正式版次的两网关全量下载及 10,001 文件比对仍待完成**，不能据此手工填入成功证据。

前端 `VITE_IPFS_GATEWAY` 只接受纯 HTTPS 基址；正式 NFT 构建必须显式采用仍提供服务且已验证的网关，检查 `scripts/build-visitor.mjs` 的实际配置，不沿用旧 `https://ipfs.io` 回退。本次新版前端尚未发布。合约保存的是 CID，不是网关，所以换网关不需要重新部署；大陆网络能否直连取决于所选网关，参考下文「网关与备案」。

1. 持久 pin `publish/` 的**内容**，使目录根直接包含 `collection.json` 和 `portraits/`。只上传这个公开目录；不要将领取材料、整个仓库或预览页面打入其中。
2. 保留真实目录 CID（CIDv1 dag-pb/SHA-256、小写 `bafy`、59 字符）。通过至少两个独立运营的 HTTPS 网关下载全部 10,001 个文件，并与本地已核验版次比较 SHA-256。出现缺图或失败时停止。
3. 由实际 pin/下载核验工具输出下面的证据格式。**不能手工把 `pinned` 或计数改成成功值。** 离线准备器检查证据与本地版次绑定；它本身不会重新联系网关或证明 pin 服务将永久运行。

证据结构（下列是字段说明，不是成功报告）：

```text
schema: "glowpet-ipfs-verification-v1"
cid: 实际目录 CID
editionSize: 10000
manifestSha256: collection.json 的 SHA-256
fileSetSha256: 下面定义的完整文件清单摘要
pinned: 实际 pin 服务确认后为 true
gateways: 至少两个网关核验结果，每个包含：
  baseUrl: HTTPS 网关基地址，不带用户名、密码或查询参数
  manifestSha256: 下载后 collection.json 的 SHA-256
  fileSetSha256: 全部下载文件的清单摘要
  verifiedFiles: 10001
  failedFiles: 0
  verifiedAt: 实际核验时间（ISO 8601）
```

`fileSetSha256` 的计算：收集 `collection.json` 及清单中全部 `portraits/<appearanceId>.png`，按文件路径升序排列，每行编码为 `路径 + NUL + 小写 SHA-256 + LF`，对拼接后的 UTF-8 字节计算 SHA-256。工具可复用导出的 `publishedFileSetHash`；远端值必须来自实际下载内容。仅检查清单而不下载图片不足以生成报告。

有真实证据、且已重新读取钱包 pending nonce 后，在**新文件**中准备交易：

```text
node scripts/prepare-sepolia-release.mjs
  --manifest <已核验版次的 collection.json>
  --series <公开 series.json>
  --from <MetaMask 当前公开地址>
  --out <新的交易计划 JSON 文件>
  --cid <真实目录 CID>
  --ipfs-report <实际远端核验报告 JSON>
  --nonce <刚读取的 pending nonce>
```

此阶段会用锁定 Solidity 编译器重新编译。输出两笔未签名交易：部署 `DeltaXGlowpet(CID, 10000, artworkSeed)`（构造函数内部部署 `DeltaXPortraits`），以及向预测地址发送的 `createSeries`。部署交易不含 `to`，两笔均固定为 Sepolia、ETH 转账值为零。费用场景只用于说明量级；来自本地合成 CID、短 label 的模拟，不是现场报价，gas limit 与费用应在钱包提交前实时估算。

## 钱包签名前后的检查

先核对网络、账户、余额、pending nonce 和费用。部署者的其他交易会改变预测合约地址；计划过期时重新生成，不能把旧 nonce 当成长期配置。

部署签名完成后，确认回执成功、实际合约地址等于计划地址，再读回 `owner`、`artworkVersion`、`editionSize`、`artworkSeed`、`art` 和图片合约的 `directoryURI`。只有核对一致后，才重新检查 nonce 并提交第二笔 `createSeries`。随后核验 series ID、root、supply、open 和 `minted=0`。

网站及服务端配置实际地址与部署区块，EIP-712 授权使用新合约地址。认领凭证通过私密渠道分发，不能放入静态网站。受控领取后检查实际图片、属性、不可重复领取、转让和成长不改变固定外观。Sepolia 结果只证明测试网流程；IPFS 持续保存、网站后端和主网发行另行验收。

不要运行 `scripts/deploy-local.mjs` 来发布：它使用公开的本地测试钱包，并写入本地 env。

## 网关与备案

- 合约和 `tokenURI` 保存的是 `ipfs://<CID>/...`，网关只是浏览器侧配置（`VITE_IPFS_GATEWAY`），换网关不需要重新部署合约。
- 直接引用第三方网关（如 Pinata 专用网关、Filebase 公共网关）不产生 ICP 备案义务：域名不由本项目运营。
- 自有域名 CNAME 到境外网关一般不触发备案；解析到大陆服务器或走大陆 CDN 加速则必须先完成 ICP 备案。
- 面向境内公众提供区块链信息服务另需网信办区块链信息服务备案（《区块链信息服务管理规定》），与 ICP 备案是两件事。
