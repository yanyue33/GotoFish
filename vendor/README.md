# vendor/

本目录存放第三方库的本地副本。游戏本身不需要联网，也不需要联网加载任何资源。

| 文件 | 版本 | 用途 | 许可证 |
| --- | --- | --- | --- |
| `three.module.js` | three.js r169 | 3D 渲染 | MIT（见 `LICENSE-three.txt`） |

下载命令（已执行，记录在此便于复现）：

```powershell
curl.exe -sL -o vendor/three.module.js https://unpkg.com/three@0.169.0/build/three.module.js
curl.exe -sL -o vendor/LICENSE-three.txt https://unpkg.com/three@0.169.0/LICENSE
```

> 为什么不用构建工具：本游戏是纯 ES Module + WebGL，没有任何需要编译的语法。
> 直接静态托管即可运行（`node tools/serve.mjs`），省掉了打包步骤与构建故障面。
> 逻辑层（`src/core`、`src/data`、`src/systems`）完全不 import three，
> 因此可以在 Node 里直接跑单元测试，见 `tests/`。
