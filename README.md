# pi-provider-hub

[![npm](https://img.shields.io/npm/v/pi-provider-hub-multi.svg)](https://www.npmjs.com/package/pi-provider-hub-multi)
[![license](https://img.shields.io/npm/l/pi-provider-hub-multi.svg)](LICENSE)
[![test](https://github.com/Sunrisies/pi-provider-hub/actions/workflows/test.yml/badge.svg)](https://github.com/Sunrisies/pi-provider-hub/actions/workflows/test.yml)

pi 扩展：把多个 API 站点集中管理在一个文件里，自动拉取模型列表并直接注册给 `/model` 使用。不再手写 `models.json`。

> npm 包名：`pi-provider-hub-multi`（`pi-provider-hub` 已被同名项目占用）。安装命令以 `package.json` 的 name 为准。

- 支持任意 OpenAI 兼容站点、Anthropic、OpenAI Responses、Google Generative AI
- 输入站点名称 + Base URL + API Key 即可自动发现模型
- 自动探测鉴权方式（Bearer / x-api-key / x-goog-api-key）与版本路径（`/v1/models`、`/models`）
- 自动跳过 embedding / 语音 / 图像生成等非对话模型
- 模型元数据（上下文长度、是否支持图片、是否推理模型）优先取接口返回值，缺失时按名称推断
- 启动时不联网：注册上次成功发现的模型；新增、刷新、删除即时生效
- 内置连接测试：对指定模型发一条最小请求，返回延迟与回复

## 安装

作为 pi 包安装（推荐，可随 `pi update` 升级）：

```bash
pi install npm:pi-provider-hub-multi
```

从本地目录安装（不复制文件，只写入 settings）：

```bash
pi install ./pi-provider-hub
```

从 GitHub 安装（可固定 tag）：

```bash
pi install git:github.com/Sunrisies/pi-provider-hub@v0.2.1
```

也可以直接复制整个目录到 pi 的扩展目录：

```bash
cp -r pi-provider-hub ~/.pi/agent/extensions/pi-provider-hub
```

Windows（PowerShell）：

```powershell
Copy-Item -Recurse pi-provider-hub "$env:USERPROFILE\.pi\agent\extensions\pi-provider-hub"
```

重启 pi，输入 `/providers` 即可看到入口。临时试用而不安装：

```bash
pi -e /path/to/pi-provider-hub/index.ts
```

## 卸载

从 npm 或 git 安装的，用 `pi remove` 从 settings 里移除：

```bash
pi remove npm:pi-provider-hub-multi
# 或
pi remove git:github.com/Sunrisies/pi-provider-hub
```

手动复制到扩展目录的，删掉那个目录即可：

```bash
rm -rf ~/.pi/agent/extensions/pi-provider-hub
```

两种方式都**不会**删除 `~/.pi/agent/provider-hub.json`。站点的 URL 和 API Key 存在这个文件里，重装后可以直接复用；确认不再需要时再手动删除。

注意不要同时用两种方式安装：扩展目录里有一份、`packages` 里也有一份时，同一个 provider id 会被注册两次。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/providers` | 打开站点菜单（添加 / 选择站点） |
| `/providers add` | 添加站点 |
| `/providers list` | 查看已配置站点及详情 |
| `/providers test [id]` | 发一条最小请求测试连接 |
| `/providers refresh [id]` | 重新拉取模型列表 |
| `/providers edit [id]` | 修改 Base URL / Key / 协议 |
| `/providers remove <id>` | 删除站点 |
| `/providers path` | 显示配置文件路径 |

不写 `[id]` 时会用选择框挑站点；命令支持补全。

## 添加流程

1. 站点名称（显示名，例如 `My Proxy`）
2. Provider ID（由名称自动生成；纯中文时会追问一个英文短 ID）
3. Base URL（例如 `https://api.example.com/v1`，也可以直接填 `api.example.com`）
4. API Key（明文输入，仅保存在本机；pi 的输入框不支持掩码）
5. 接口协议：默认「自动检测」，也可手动指定
6. 拉取模型 → 输入筛选关键词（留空 = 全部；逗号/空格分隔；`-word` 排除）
7. 预览并确认 → 保存并立即注册

添加完成后打开 `/model` 就能看到新站点下的模型。

## 测试连接

`/providers test [id]` 或站点菜单里的「测试连接」会对一个模型发送最小请求（最多 16 tokens）：

- 按站点协议选择端点：OpenAI `/chat/completions`、Anthropic `/messages`、Responses `/responses`、Google `:generateContent`
- 成功时显示往返延迟与一小段回复；失败时显示 HTTP 状态和站点返回的错误信息
- 超时 20 秒；请求不会写入会话，也不影响已注册的模型

只填域名（如 `api.example.com`）的站点，发现成功后会把 `baseUrl` 补成实际可用的版本路径（如 `/v1`），否则聊天请求会打到错误的位置。

## 配置文件

位置：`~/.pi/agent/provider-hub.json`（权限 `0600`，原子写入）。

```json
{
  "version": 1,
  "providers": [
    {
      "id": "my-proxy",
      "name": "My Proxy",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "sk-...",
      "api": "openai-completions",
      "filter": "claude,gpt",
      "models": [
        {
          "id": "gpt-4o",
          "name": "gpt-4o",
          "reasoning": false,
          "input": ["text", "image"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 131072,
          "maxTokens": 8192
        }
      ],
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

这个文件是插件的唯一数据源，扩展**不会**修改 `models.json`。也可以手动编辑（保存后重启 pi 生效，或 `/providers refresh <id>` 更新）。

## 模型发现细节

- 依次尝试 `base/models` 与 `base/v1/models`；只有主机名时优先 `/v1/models`；Google 站点用 `/models` 与 `/v1beta/models`
- 鉴权自动探测：先 `Authorization: Bearer`，401/403 再尝试 `x-api-key`（Anthropic 风格）；Google 用 `x-goog-api-key`
- 兼容 `{data:[…]}`、`{models:[…]}`、`{result:{data:[…]}}` 和裸数组
- 超时 15 秒；失败时提示每条候选端点的状态
- 文本里的 `$` 与开头的 `!` 会被转义，避免被 pi 当作环境变量或命令执行

## 开发与测试

```bash
cd pi-provider-hub
node --test test/*.test.ts
```

若测试运行器在受限环境里报 `spawn EPERM`（子进程被沙箱拦截），逐个文件运行即可：

```bash
node test/store.test.ts
node test/discovery.test.ts
node test/infer.test.ts
node test/probe.test.ts
node test/flow.test.ts
```

共 45 个用例：`store` 10、`discovery` 14、`infer` 5、`probe` 10、`flow` 6（含本地 HTTP mock 走完整的添加 + 测试连接流程）。
单测覆盖：URL 规范化、候选端点、响应解析、非对话模型过滤、关键词筛选、元数据推断、密钥转义、配置读写与损坏恢复、鉴权重试、四种协议的请求构造与连接测试。

## 类型检查（编辑器环境）

```bash
npm install          # typescript + pi 的类型声明 + @types/node
npm run typecheck    # tsc --noEmit
```

之前编辑器报类型错误，是因为缺少 `tsconfig.json` 和本地类型依赖：

- 源码按 pi 的 jiti 加载方式直接写 `./src/flows.ts`，默认的 TS 配置会报 “An import path can only end with a '.ts' extension…”；现在 `tsconfig.json` 开了 `allowImportingTsExtensions` + `noEmit`。
- 默认的 `node10` 模块解析找不到 `@earendil-works/pi-coding-agent` 的类型；现在用 `module`/`moduleResolution: NodeNext`，并把它装成 devDependency（运行时仍由 pi 通过 `peerDependencies` 提供，不会打进包）。
- VS Code 若仍标红：命令面板执行 “TypeScript: Select TypeScript Version” → “Use Workspace Version”，并确认打开的是 `pi-provider-hub` 目录（或包含它的工作区），让 TS Server 用上这份 `tsconfig.json`。

## 发布

已发布到 npm（`pi-provider-hub-multi`），发布新版本：

```bash
npm version patch          # 或 minor / 指定版本号
npm publish --access public
git push --follow-tags
```

`pi install` 安装的是 npm 包，`pi.dev/packages` 会自动收录（只需 `keywords` 里有 `pi-package`）。想用自己的作用域，把 `name` 改成 `@your-scope/pi-provider-hub`，发布用 `npm publish --access public`，安装命令同步替换。发布前可用 `npm pack --dry-run` 预览会打进去的文件（`test/` 不会发布）。

## 已知限制

- 预览与注册使用插件内保存的模型列表；刷新不会自动联系模型详情接口
- 模型价格统一写 0（仅影响成本显示，不影响调用）
- 输入 API Key 时无法遮挡（pi 的 `ctx.ui.input` 不支持密码模式）
- 不提供图形面板，全部走命令 + 选择框