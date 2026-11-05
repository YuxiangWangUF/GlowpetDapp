# Sepolia 10,000 只版次发布材料

目标网络为 **Sepolia（11155111）**，版次和领取系列上限为 **10,000**；部署及创建系列后已铸造数量为 **0**。每次成功领取才铸造一个 NFT。公开的美术种子不是领取凭证种子。

当前阶段先完成本地材料。没有真实 IPFS 目录 CID 和远端核验记录时，不能生成可提交的部署交易，也不能宣称已发布。原 `output/deltax-unique-v2/` 的 100 张冻结版次保留；一万张新版次必须完整生成并核验，不能只改供应量。

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

已选服务为 **Pinata Picnic**（1 TB，13 GB 版次在官方推荐的 15 GB 上限内）。凭证只放在 shell 环境变量 `PINATA_JWT`，不写入任何文件或 `.env`。

三个步骤都由仓库脚本完成，CID 全部在本地计算，上传结果必须与本地根一致：

```sh
# 1. 只打包、不上传：得到目录 CID 并检查目录结构，不需要账号
node scripts/ipfs-publish.mjs \
  --dir output/deltax-unique-v2-10000-sepolia-20261103/publish \
  --out deployments/sepolia-10000-20261103/ipfs-publish-draft.json --dry-run

# 2. 上传（超过 90 MB 自动走分块续传，car=true），写出发布记录
PINATA_JWT=... node scripts/ipfs-publish.mjs \
  --dir output/deltax-unique-v2-10000-sepolia-20261103/publish \
  --out deployments/sepolia-10000-20261103/ipfs-publish.json

# 3. 两个独立网关全量下载校验，生成可用作 --ipfs-report 的证据
PINATA_JWT=... node scripts/ipfs-verify.mjs \
  --dir output/deltax-unique-v2-10000-sepolia-20261103/publish \
  --cid bafy... \
  --publish-record deployments/sepolia-10000-20261103/ipfs-publish.json \
  --gateway https://<专用网关>.mypinata.cloud --gateway https://ipfs.io \
  --out deployments/sepolia-10000-20261103/ipfs-verification.json
```

校验脚本会先向 Pinata 复核记录中的文件仍解析到该 CID（`pinned` 只能由这次复核置为 true），再逐张下载并比对哈希；中断后重跑会复用已校验文件。两个网关必须主机名不同。

前端不再写死网关：`VITE_IPFS_GATEWAY` 只接受纯 HTTPS 基址（空值回退 `https://ipfs.io`），游客构建在 `scripts/build-visitor.mjs` 中显式设置。合约保存的是 CID，不是网关，所以换网关不需要重新部署；大陆网络能否直连取决于所选网关，参考下文「网关与备案」。

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
- 直接引用第三方网关（Pinata 专用网关、`ipfs.io` 等）不产生 ICP 备案义务：域名不由本项目运营。
- 自有域名 CNAME 到境外网关一般不触发备案；解析到大陆服务器或走大陆 CDN 加速则必须先完成 ICP 备案。
- 面向境内公众提供区块链信息服务另需网信办区块链信息服务备案（《区块链信息服务管理规定》），与 ICP 备案是两件事。
