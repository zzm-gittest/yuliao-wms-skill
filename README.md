# yuliao-wms-skill

[dsh](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）的
**WMS / 轻量 ERP 助手插件**：在 dsh 主聊天框里直接对接
[RuoYi-AI-WMS](https://gitee.com/) 进销存 AI 助手——自然语言开单、选商品、
核对预览、确认执行，全程在对话内完成，无需打开任何独立面板。

```
你: /yuliao-erp 向牛飞冷链采购5箱苹果，每箱8元
AI: 【单据创建确认】供应商：牛飞冷链 …（下方出现可编辑预览卡片）
你: （在卡片里改数量/单价，点【确认】）
AI: 采购订单 CG20261124xxxx 已创建
```

## 功能

- **对话透传**：`/yuliao-erp` 后主聊天框即 WMS PC AI 助手本人，消息原样转发、回复原样转述；
- **聊天内业务卡片**：候选商品选择（含「以上都不是」逃逸）、可编辑单据预览
  （供应商/客户/仓库下拉自选、明细行内编辑、金额自动计算）、商品创建
  （单位/分类下拉 + 旁挂「新增」内联创建，分类支持一级）、执行结果
  （头信息 + 修改/审核/删除/打印 PDF）；
- **聊天内登录**：未登录或登录失效时，聊天里直接出现「连接 WMS」登录卡，
  不需要任何独立面板；登录态持久化，跨重启有效；
- **退出登录**：对话里输入「退出登录」即可注销当前账号；
- **LLM 桥**（可选）：WMS 后端的模型调用可通过 `/wms-llm/chat` 桥接端点
  复用 dsh「设置 → 模型」里配置的模型，WMS 侧不持有任何模型 Key。

## 环境要求

| 依赖 | 版本 |
| --- | --- |
| [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）源码 | 本地 clone |
| Node.js | >= 24.9 |
| pnpm | 与 dsh 要求一致 |
| RuoYi-AI-WMS（含 AI 助手模块） | 运行中，默认 `http://127.0.0.1:8080` |

## 安装（一键脚本）

Windows 双击 **`install-windows.bat`**；macOS 双击 **`install-macos.command`**
（或在终端 `bash install-macos.command`）。脚本会：

1. 提示你输入 dsh 仓库路径；
2. 复制两个插件包到 `packages/experimental/`；
3. 幂等打补丁（`patches/apply-wms-patch.mjs`）：在
   `packages/bundle/web-app/cordis.patch.yml` 注册 `wms-ai`，在
   `packages/bundle/web-app/package.json` 加 workspace 依赖
   （首次修改前自动备份为 `*.yuliao-bak`，重复执行安全）；
4. `pnpm install` 并构建两个插件；
5. 打印启动命令。

## 启动

```sh
cd <你的 dsh 仓库>
pnpm dsh web --patch ./overlays/wms-dsh-bridge.yml
```

`--patch` 仅用于挂载 LLM 桥端点（让 WMS 后端复用 dsh 的模型配置）；
只使用聊天助手功能时可不带。启动后在 Web 界面聊天框输入 `/yuliao-erp`，
首次使用会在聊天里出现「连接 WMS」登录卡，填地址（可留空走默认）、
账号、密码即可。

### 环境变量（可选）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `WMS_BASE_URL` | `http://127.0.0.1:8080` | 登录卡里预填的 WMS 地址 |
| `DSH_WMS_BRIDGE_SECRET` | 本机联调默认值 | LLM 桥共享密钥，**线上务必设置**（>=16 位随机串），并与 WMS `dsh.gateway.bridge-token` 一致 |

## 卸载

1. 删除 `<dsh>/packages/experimental/wms-ai` 与
   `<dsh>/packages/experimental/wms-llm-bridge`；
2. 从 `cordis.patch.yml` 删除 `- id: wms-ai` 块、从
   `web-app/package.json` 删除两行 `dsh-wms-*` 依赖（或还原 `*.yuliao-bak`）；
3. `pnpm install` 后重新构建 web-app。

## 目录结构

```
packages/wms-ai            # 主插件：skill(/yuliao-erp) + 工具 + 登录/代理路由 + 聊天卡片 UI
packages/wms-llm-bridge    # LLM 桥插件：/wms-llm/chat、/wms-llm/vision 端点
overlays/wms-dsh-bridge.yml# LLM 桥 overlay（--patch 加载）
patches/apply-wms-patch.mjs# 幂等安装补丁脚本
```

## 许可

MIT。注意：本插件依赖 dsh（deepseek-harness）本体，仅作为其插件运行；
WMS 后端需自行部署 RuoYi-AI-WMS（含 AI 助手模块）。
