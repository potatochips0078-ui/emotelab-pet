# Emotelab Pet 需求文档

> 版本：v1.0 | 日期：2026-11-12 | 状态：已确认，待实施

---

## 一、产品定位

**一个轻量、独立的 Emotelab 角色桌宠播放器**。用户不需要运行 Emotelab，只需导入角色数据即可在桌面上获得一个可互动的桌宠。首次启动内置默认角色 CoffeeBean "没想好"。

### 目标用户
- 已有 Emotelab 角色、想让它们活在桌面上的玩家
- 喜欢桌宠软件、想获得比静态 GIF / Live2D 更丰富表现力的用户

### 核心价值
- 复用 Emotelab 生态的 Spine 2D 角色（骨骼动画 + 物理 + 皮肤换色）
- 动作直接来自角色本身的 animation clip（撬棍、枪、睡觉、害羞、生气、打字、点赞...）
- 与 Emotelab 保持独立性，角色数据可单独打包分享

---

## 二、技术栈

| 层 | 选型 | 说明 |
|----|------|------|
| 桌面框架 | **Electron** | 多窗口、透明置顶、跨平台 |
| 构建工具 | **electron-vite** | TypeScript + Vite 快速开发 |
| UI 框架 | **Vue 3 + TypeScript** | 设置界面用 |
| 2D 渲染 | **PixiJS** | WebGL 高性能渲染 |
| 骨骼动画 | **spine-ts + spine-pixi** | 官方 Spine 4.3 runtime，支持二进制 .skel |
| 配置持久化 | **electron-store** | JSON 文件，存 AppData |
| 资源提取 | **UnityPy → PyInstaller 打包成 extractor.exe** | 独立可执行文件，用户不需要 Python |

---

## 三、窗口架构

四个 BrowserWindow 各自独立渲染，主进程统一管理：

| 窗口 | 类型 | 关键属性 | 职责 |
|------|------|---------|------|
| **桌宠窗口** | 透明无边框 | `frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true` | PixiJS + Spine 渲染角色、处理拖拽和左键互动 |
| **右键菜单 Popup** | 透明小窗 | `frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, focusable: false` | 右键触发，桌宠旁边弹出动作菜单，失焦自动关闭 |
| **设置窗口** | 正常窗口 | `frame: true`，有最小化/关闭 | 4 Tab 配置界面 |
| **主进程** | 非窗口 | Tray 图标 + IPC 注册 + 配置读写 + 资源扫描 | - |

```
┌────────────────────────────────────────────────────┐
│                   Electron 主进程                     │
│  ┌─ Tray ─┐  ┌─ electron-store (config.json) ─┐   │
│  │ 托盘图标│  │ 用户设置 + 角色索引 + 状态记忆   │   │
│  └────────┘  └────────────────────────────────┘   │
└────────┬──────────┬──────────┬──────────────────────┘
         │          │          │
    ┌────▼────┐ ┌───▼────┐ ┌──▼────┐
    │ PetWin  │ │ MenuWin│ │SetWin │
    │ 桌宠     │ │ 右键菜单│ │ 设置  │
    └─────────┘ └────────┘ └───────┘
```

---

## 四、核心交互逻辑

### 4.1 点击 vs 拖拽判定

位移阈值 5px，用 requestAnimationFrame 合并 mousemove IPC 调用避免风暴。

```
mousedown → 记录起始坐标 startPos
mousemove → 累计总位移 distance
  ├─ distance < 5px → 仍视为 click
  └─ distance ≥ 5px → 切换为 drag 模式
       ├─ mouseup → drag 结束
       │   ├─ 速度低 → 停住
       │   └─ 速度高 → 触发惯性物理
       └─ mousemove → rAF 合并，每帧最多一次 IPC
mouseup（从未触发 drag）→ 判定为 click 或 double_click
```

### 4.2 动作触发表（默认值 + 可配置性）

| 事件 | 默认行为 | 可覆盖 |
|------|---------|--------|
| 左键快速点击 | 友好池随机（blink / greeting / happy / think） | ✅ 设置里单独指定 |
| 左键双击 | Surprise 动画 | ✅ |
| 左键按住 ≥5px → 拖拽 | 移动桌宠窗口 | ❌ 固定 |
| 拖拽松手 + 高速度 | 惯性晃动（阻尼物理模拟） | ❌ 固定 |
| 右键 | 弹出动作菜单 Popup | ❌ 固定 |
| 鼠标悬停 ≥2s | Blink（仅当前无动画播放时） | ✅ |
| 空闲 ≥30s | Idle 动画循环（可配时长） | ✅ |
| 空闲 ≥5min | Sleep 动画（可配时长） | ✅ |
| 1 分钟内点击 ≥15 次 | 累了 → Work_Tired 动画（可配阈值） | ✅ |

### 4.3 右键菜单 Popup

定位逻辑：桌宠屏幕中心 → 默认开右侧 → 超出边界则左侧翻转 → 底部空间不足则向上翻转。Popup 失焦自动关闭。

菜单项分为两组：

```
┌─────────────────────────────────┐
│  😊 开心      ← 动作项（从设置  │
│  😠 生气         里勾选启用）    │
│  😴 睡觉                        │
│  🤔 思考                        │
│  🔫 枪                          │
│─────────────────────────────────│
│  ⚙️ 设置...                      │
│  📁 角色管理                      │
│  👁️ 隐藏桌宠                      │
└─────────────────────────────────┘
```

### 4.4 状态记忆系统（运行期，不持久化）

简化实现，基于计数器的 mood 状态：

```json
{
  "clickCount_minute": 0,
  "idleSince": 1731355200000,
  "mood": "normal",
  "lastPlayedAnimation": "",
  "animationCooldown": {}
}
```

不暴露 SliderConstraints 到设置界面，只处理 ActiveSkins 皮肤选择。

---

## 五、物理惯性实现（简化）

拖拽松手瞬间捕获速度 `(vx, vy)`，然后每帧：

```
vx *= 0.92   // 线性阻尼
vy *= 0.92
pos.x += vx
pos.y += vy

if |vx| + |vy| < 0.5 → 停止物理，恢复正常动画
```

物理期间在 Spine 角色上叠加轻微根骨骼偏移产生身体晃动效果。

---

## 六、角色管理

### 6.1 内置默认角色

软件分发包包含 CoffeeBean "没想好" 的完整数据：

```
resources/default-character/
├── CoffeeBean_V1_9.skel
├── CoffeeBean_V1_9.atlas
├── CoffeeBean.png
├── CoffeeBean_2.png ~ CoffeeBean_16.png
├── 没想好.json                    # CharacterName.json 风格的皮肤预设
└── meta.json                      # 角色元信息
```

meta.json 格式：

```json
{
  "name": "CoffeeBean 没想好",
  "modelKey": "CoffeeBean",
  "version": "1.9",
  "animationClips": [
    "ANIM/PNGTuber-Idle2",
    "ANIM/Blink-11",
    "ANIM/Greeting-1-",
    "ANIM/Surprise0",
    "ANIM/Draw-Angry4",
    "ANIM/Think-Serious5",
    "ANIM/Sleep-Normal",
    "ANIM/Sleep-Preparing-Stage1",
    "ANIM/Work-AngryB",
    "ANIM/Gun-TriggerHappy-"
  ],
  "friendlyPool": ["ANIM/PNGTuber-Idle2", "ANIM/Blink-11", "ANIM/Greeting-1-"],
  "skinSlots": ["Eye", "Brows", "HairBangMiddle", "OutfitInner", "NeckwearB"]
}
```

### 6.2 Emotelab 资源发现流程

```
软件启动
  │
  ├─ Step 1: 加载内置默认角色（永远可用）
  │
  ├─ Step 2: 扫描 Documents/EmoteLab/Characters/
  │           读取 CharacterName.json → 获取 SharedModelKey
  │
  ├─ Step 3: 自动探测 Emotelab 安装目录
  │           方式：注册表、默认 Steam 路径、用户上次手动选择
  │
  ├─ Step 4: 找到 .bundle → 调用 extractor.exe 解压
  │           缓存到 AppData/emotelab-pet/cache/<ModelKey>/
  │           bundle hash 变了才重新解压
  │
  └─ Step 5: 用户也可以手动"导入角色包"
              支持两种输入：文件夹（含 .skel + .atlas + PNGs）
                           或 .bundle 文件（走同样解压流程）
```

### 6.3 角色包格式（导出/导入标准）

任何用户都可以从 Emotelab 提取后分享：

```
MyCharacter/
├── meta.json              # 必须
├── ModelName.skel         # 必须（支持 .skel 二进制或 .json 文本）
├── ModelName.atlas        # 必须
├── texture1.png           # 必须
├── ...
└── character.json         # 可选（CharacterName.json 风格皮肤预设）
```

---

## 七、设置界面

正常窗口，左侧导航 + 右侧内容，4 个 Tab：

### 7.1 角色 Tab

- 角色卡片网格（缩略图 + 名称 + 当前皮肤预设）
- [+ 导入角色包] 按钮 → 选文件夹或 .bundle
- [重新扫描 Emotelab] 按钮
- 外观调整区域（当前选中角色）：
  - 每个 ActiveSkins slot 一个下拉框
  - 示例：发型 ▾ / 眼睛 ▾ /  outfit ▾ / 领饰 ▾
- [恢复默认皮肤] 按钮

### 7.2 行为 Tab

| 设置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| 左键点击 | 下拉 | 友好池随机 | 或指定具体动画 |
| 双击 | 下拉 | Surprise | - |
| 悬停 | 下拉 | Blink | - |
| 空闲超时 | 滑块/下拉 | 30 秒 | 进入 idle 循环 |
| 睡眠超时 | 滑块/下拉 | 5 分钟 | 进入 sleep |
| 疲累阈值 | 滑块 | 15 次/分钟 | - |
| 右键菜单动作 | 多选勾选 | friendlyPool 全部 | - |
| 开机自启 | 开关 | 关 | - |

### 7.3 显示 Tab

| 设置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| 角色缩放 | 滑块 | 1.0 | 0.5x ~ 2.0x |
| 拖拽甩动物理 | 开关 | 开 | - |
| 边缘吸附 | 开关 | 开 | 拖到屏幕边缘自动吸附 |
| 吸附距离 | 滑块 | 20px | - |
| 点击穿透 | 三选一 | 从不穿透 | 从不穿透 / 静止时穿透 / 始终穿透（MVP 先实现从不穿透 + 始终穿透） |
| 多显示器 | 下拉 | 仅主屏 | 仅主屏 / 跟随鼠标屏 / 所有屏幕 |
| 置顶等级 | 下拉 | 最顶层 | 最顶层 / 正常置顶 |

### 7.4 关于 Tab

- 版本号
- Emotelab 路径：自动探测结果 + 手动选择按钮
- 缓存路径：AppData 位置 + 清除缓存按钮
- 第三方许可

---

## 八、配置持久化

用 `electron-store`，存储位置：

- Windows: `%APPDATA%/emotelab-pet/config.json`
- macOS: `~/Library/Application Support/emotelab-pet/config.json`

配置文件结构：

```json
{
  "activeCharacter": {
    "name": "CoffeeBean 没想好",
    "path": "resources/default-character/",
    "skinOverrides": {
      "OutfitInner": "OutfitInner6_String",
      "NeckwearB": "NeckwearB7"
    }
  },
  "animationBindings": {
    "leftClick": "random_friendly",
    "doubleClick": "ANIM/Surprise0",
    "hover": "ANIM/Blink-11",
    "idleTimeout": 30,
    "sleepTimeout": 300,
    "tiredThreshold": 15,
    "rightMenuActions": ["greeting", "angry", "happy", "sleep", "think", "gun"]
  },
  "display": {
    "scale": 1.0,
    "physicsFollow": true,
    "edgeSnap": true,
    "edgeSnapDistance": 20,
    "clickThrough": "never",
    "multiMonitor": "primary",
    "alwaysOnTopLevel": "screen-saver"
  },
  "position": { "x": 1200, "y": 600 },
  "autoStart": false,
  "emotelabPath": null,
  "cacheVersion": "1.0"
}
```

---

## 九、文件结构

```
emotelab-pet/
├── package.json
├── electron.vite.config.ts
│
├── electron/                        # 主进程
│   ├── main.ts                      # 入口
│   ├── tray.ts                      # 托盘图标
│   ├── windows/
│   │   ├── petWindow.ts
│   │   ├── actionMenu.ts
│   │   └── settingsWindow.ts
│   ├── ipc/
│   │   ├── characterIPC.ts
│   │   ├── settingsIPC.ts
│   │   └── behaviorIPC.ts
│   ├── core/
│   │   ├── characterLoader.ts       # .skel/.atlas/PNG → 内存
│   │   ├── characterParser.ts       # CharacterName.json → 皮肤组合
│   │   ├── stateMemory.ts           # 状态记忆
│   │   └── resourceExtractor.py     # UnityPy 脚本（打包成 extractor.exe）
│   └── utils/
│       ├── config.ts                # electron-store 封装
│       ├── autostart.ts
│       └── pathFinder.ts            # Emotelab 目录探测
│
├── src/                              # 渲染进程（Vue 3）
│   ├── pet/
│   │   ├── PetApp.vue
│   │   ├── useDrag.ts               # rAF 合并 IPC + 位移阈值
│   │   ├── useInteraction.ts        # click/double_click/hover 分发
│   │   ├── usePhysicsFollow.ts      # 惯性阻尼模拟
│   │   └── useState.ts              # idle/busy/sleep/tired 状态机
│   ├── settings/
│   │   ├── SettingsApp.vue
│   │   ├── CharacterTab.vue
│   │   ├── BehaviorTab.vue
│   │   ├── DisplayTab.vue
│   │   └── AboutTab.vue
│   └── menu/
│       └── ActionMenu.vue
│
├── resources/                        # 内置默认角色
│   └── default-character/
│       ├── CoffeeBean_V1_9.skel
│       ├── CoffeeBean_V1_9.atlas
│       ├── CoffeeBean.png
│       ├── CoffeeBean_2.png ~ CoffeeBean_16.png
│       ├── 没想好.json
│       └── meta.json
│
└── build/
    └── extractor.exe                 # PyInstaller 产物
```

---

## 十、开发阶段

```
Phase 1 — 骨架 & 渲染 (3天)
├── electron-vite + Vue 3 脚手架
├── 桌宠窗口：透明 + 无边框 + 置顶
├── 接入 PixiJS + spine-ts
├── 加载默认 CoffeeBean，播放 Idle 动画
└── 拖拽移动（先不做物理）

Phase 2 — 互动 & 右键菜单 (2天)
├── click vs drag 阈值判定
├── 点击 → 友好池随机
├── 双击 → 指定动画
├── 右键 BrowserWindow Popup 菜单
├── 惯性阻尼物理
└── 空闲/睡眠状态机

Phase 3 — 设置界面 (3天)
├── 设置窗口 4 Tab 框架
├── electron-store 配置读写
├── 角色 Tab：皮肤下拉
├── 行为 Tab 完整落地
└── 显示 Tab 完整落地

Phase 4 — 资源管理 (3天)
├── extractor.exe 打包
├── Emotelab 路径自动探测
├── 角色扫描 & 索引
├── 手动导入角色包
├── 缓存 + bundle hash 检测
└── 多角色切换

Phase 5 — 打磨 (2天)
├── 系统托盘图标
├── 边缘吸附
├── 点击穿透
├── 多显示器
├── 开机自启
└── 打包 .exe（electron-builder）
```

**总计约 13 天**

---

## 十一、已确认的边界 & 排除项

| 项 | 决定 |
|----|------|
| 初始支持角色数 | 一个，多角色在设置界面加 |
| SliderConstraints 参数滑杆 | 不暴露到设置界面 |
| 点击穿透 | MVP 只实现"从不穿透"和"始终穿透"，"静止时穿透"延后 |
| 跨平台 | 先做 Windows，macOS/Linux 后续 |
| 物理骨骼模拟 | 依赖 spine-ts runtime 原生支持，不自己实现 |
| 非 Emotelab 角色 | 暂不支持，但角色包格式为通用 Spine 格式留了扩展口子 |

---

## 十二、踩坑备忘（实战经验）

1. **mousemove IPC 必须 rAF 合并** — 高频触发会卡死主进程
2. **窗口引用生命周期** — closed 事件置空全局引用，Tray 回调里检查 isDestroyed()
3. **资源路径禁止 `../` 段** — electron-vite 打包后 URL normalize 会出问题，统一用 `app.getAppPath() + resources/`
4. **click/drag 位移阈值 5px** — 太小会导致正常点击被误判
5. **electron-store 用独立 name** — 避免和其他 Electron app 配置文件冲突

---

*文档到此。如无异议，按 Phase 1 开工。*
