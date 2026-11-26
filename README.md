# Emotelab Pet

把 EmoteLab 角色作为桌面宠物运行在 Windows 桌面上。基于 Electron + TypeScript + PIXI v7 + Spine 4.3。

## 下载

到 [Releases](https://github.com/potatochips0078-ui/emotelab-pet/releases/latest) 下载最新版本，仅支持 Windows x64：

- `Emotelab.Pet.Setup.0.1.4.exe` — 安装版（推荐）
- `Emotelab.Pet.0.1.4.exe` — 免安装便携版

## 功能

- **Spine 角色渲染**：按 `character.json` 的 `ActiveSkins` 组合皮肤，按 `SlotGroups` 染色
- **多角色同屏**：最多 6 只任意角色混搭，角色之间水平互斥推挤、撞击弹开
- **拖拽甩抛**：拎起角色有弹簧手感，松手可甩出去，撞墙/落地会反弹并压扁回弹
- **透明区域点击穿透**：只有角色身体可点击，其余区域不挡桌面
- **Steam 创意工坊**：自动扫描本地已订阅的 EmoteLab 工坊角色，设置页一键添加/切换，内容更新后自动失效重解包
- **角色导入**：支持 `.elpack` 角色包、EmoteLab 导出目录（`character.json` + `.skel`/`.atlas`），支持去重、重命名、删除
- **右键菜单**：待机、动作/表情分组、角色切换、大小、始终置顶、退出
- **系统托盘**：显示/隐藏、置顶、角色管理、退出
- **其他**：单实例运行、记住位置/大小/置顶状态/阵容、开机自启、日志落盘

## 开发

```bash
cd app
npm install
npm run dev        # 开发模式
npm run typecheck  # 类型检查
```

## 打包

```bash
cd app
npm run dist
```

产物输出到根目录 `builds/`：

- `Emotelab Pet Setup 0.1.4.exe`（NSIS 安装包）
- `Emotelab Pet 0.1.4.exe`（免安装 portable 版）
- `win-unpacked/`（未打包目录，便于调试）

打包产物不入库，发布时请上传到 GitHub Releases。

## 目录结构

```
app/
  electron/main/      主进程：窗口、托盘、菜单、角色管理、工坊扫描、配置
  electron/preload/   preload 桥接
  src/pet/            渲染进程：PIXI/Spine 渲染、多实例物理、碰撞、命中测试
  resources/          内置默认角色资源（构建时复制到 out/renderer/pet）
builds/               打包产物（不入库）
```

## 配置文件与数据

- 配置：`%APPDATA%\emotelab-pet\pet-config.json`
- 导入的角色副本：配置文件同目录下的 `characters/`
- 日志：`%APPDATA%\emotelab-pet\logs\pet.log`

如果 `%APPDATA%` 不可写，应用会自动带 `--user-data-dir=<exe目录>/pet-data` 重启自身，数据落在程序目录下的 `pet-data/`。

## 资源与版权

仓库只包含一个用于开箱体验的默认角色资源（`app/resources/default-character`）。其他角色（包括 Steam 创意工坊角色）由用户在本地导入，仅保存在自己的机器上，不会随仓库分发。

默认角色资源来自 EmoteLab，其版权归原作者所有；仓库不包含任何 Steam 创意工坊内容或第三方角色包。如果你是资源权利人并希望移除，请提交 Issue。

## 已知限制

- 仅支持 Windows
- 需要 Spine 4.3 导出的角色资源
- 角色间只做水平碰撞，不支持叠罗汉
- 同一角色多只同时上场时各自加载一份贴图，建议不超过 6 只

## 许可证

[MIT](LICENSE)
