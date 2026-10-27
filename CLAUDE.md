# CLAUDE.md

这是一份供代码助手快速理解项目的背景说明，不是强制执行清单；项目的实际行为以代码、测试和 `README.md` 为准。

## 项目概览

Steam 游戏陈列库是一个原生 Web 应用。它没有 npm 运行依赖，但需要 Node.js 20+ 启动本地静态服务与 Steam API 转发：

```powershell
npm.cmd start
npm.cmd run check
```

访问 `http://127.0.0.1:4173`，不要直接打开 `index.html`。

## 架构边界

- `src/domain.js`：纯领域逻辑；不得访问 DOM、网络或浏览器存储。
- `src/storage.js`：版本化持久化、旧数据迁移和 JSON 备份。
- `src/steam.js`：浏览器到同源 `/api/steam/*` 的请求。
- `src/app.js`：DOM 渲染、事件绑定和异步流程编排。
- `server.mjs`：静态文件白名单、安全响应头、Steam 官方接口转发。
- `data/default-library.json`：首次访问时载入的默认库。

新增可复用逻辑时优先放入领域层，并为它补充 `node:test` 测试。不要把用户可控文本写入 `innerHTML`，不要持久化或记录 Steam API Key，也不要恢复公共 CORS 代理链。

## 数据模型

```js
{
  id: string,
  name: string,
  appId: string,
  genre: string,
  rating: number, // 0 到 10，0 表示未评分
  review: string,
  addedAt: number
}
```

浏览器存储键为 `steam_game_library_v4`。`storage.js` 会自动迁移 v2/v3；导入备份时同时兼容旧数组和新的版本化对象。

## Git

- Remote：`git@github.com:Fried-Piggy/Steam-.git`
- GitHub 用户：`Fried-Piggy`
- 使用 SSH，不在命令或文档中放置 Token、密码或密钥。
