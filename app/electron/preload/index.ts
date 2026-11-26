// Electron preload script
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('petAPI', {
  // 透明区域点击穿透与角色位置
  setIgnoreMouse: (ignore: boolean) => ipcRenderer.send('pet:set-ignore-mouse', ignore),
  getOverlay: () => ipcRenderer.invoke('pet:get-overlay'),
  setPosition: (point: { x: number; y: number }) => ipcRenderer.send('pet:set-position', point),
  // 多角色：读取整个舞台，单独保存某个实例的位置
  getStage: () => ipcRenderer.invoke('pet:get-stage'),
  setInstancePosition: (payload: { id: string; x: number; y: number }) =>
    ipcRenderer.send('pet:set-instance-position', payload),
  onStage: (cb: (payload: unknown) => void) => {
    ipcRenderer.on('pet:stage', (_e, payload) => cb(payload))
  },
  onCursor: (cb: (point: { x: number; y: number }) => void) => {
    ipcRenderer.on('pet:cursor', (_e, point) => cb(point))
  },
  onCenter: (cb: (point: { x: number; y: number }) => void) => {
    ipcRenderer.on('pet:center', (_e, point) => cb(point))
  },

  // 右键菜单
  showContextMenu: (animations: string[], current: string) =>
    ipcRenderer.send('pet:context-menu', { animations, current }),
  onPlayAnimation: (cb: (name: string) => void) => {
    ipcRenderer.on('pet:play-animation', (_e, name: string) => cb(name))
  },
  onPlayIdle: (cb: () => void) => {
    ipcRenderer.on('pet:play-idle', () => cb())
  },

  // 角色
  getCharacter: () => ipcRenderer.invoke('pet:get-character'),
  onCharacterChanged: (cb: (info: unknown) => void) => {
    ipcRenderer.on('pet:character-changed', (_e, info) => cb(info))
  },
  onRenamePrompt: (cb: (payload: { id: string; name: string }) => void) => {
    ipcRenderer.on('pet:rename-prompt', (_e, payload) => cb(payload))
  },
  renameCharacter: (id: string, name: string) =>
    ipcRenderer.send('pet:rename-character', { id, name }),

  // 窗口大小 / 退出
  onWindowSize: (cb: (size: number) => void) => {
    ipcRenderer.on('pet:size-changed', (_e, size: number) => cb(size))
  },
  quit: () => ipcRenderer.send('pet:quit'),

  // 行为配置（自动动作 / 点击动作）
  getBehavior: () => ipcRenderer.invoke('pet:get-behavior'),
  onBehavior: (cb: (behavior: unknown) => void) => {
    ipcRenderer.on('pet:behavior', (_e, behavior) => cb(behavior))
  },

  // 资源路径
  resolveResource: (relativePath: string) =>
    ipcRenderer.invoke('app:resolve-resource', relativePath),
  // 工坊角色自定义贴图：按 region 名批量解析实际存在的 PNG 地址
  resolveCharacterTextures: (id: string, names: string[]) =>
    ipcRenderer.invoke('pet:character-textures', { id, names }),
  // 渲染进程关键日志落盘（主进程统一写 logs/pet.log）
  log: (level: 'warn' | 'error', message: string) => ipcRenderer.send('pet:log', { level, message }),
})

// 设置页专用：与 petAPI 分开，避免两套页面互相依赖
contextBridge.exposeInMainWorld('settingsAPI', {
  get: () => ipcRenderer.invoke('settings:get'),
  update: (patch: unknown) => ipcRenderer.invoke('settings:update', patch),
  resetPosition: () => ipcRenderer.invoke('settings:reset-position'),
  importCharacter: () => ipcRenderer.invoke('settings:import-character'),
  switchCharacter: (id: string) => ipcRenderer.invoke('settings:switch-character', id),
  renameCharacter: (id: string, name: string) =>
    ipcRenderer.invoke('settings:rename-character', { id, name }),
  deleteCharacter: (id: string) => ipcRenderer.invoke('settings:delete-character', id),
  // 桌面阵容
  addInstance: (characterId: string) => ipcRenderer.invoke('settings:add-instance', characterId),
  removeInstance: (instanceId: string) => ipcRenderer.invoke('settings:remove-instance', instanceId),
  // Steam 创意工坊角色
  listWorkshop: () => ipcRenderer.invoke('workshop:list'),
  addWorkshop: (id: string) => ipcRenderer.invoke('workshop:add', id),
  // 渲染进程关键日志落盘（主进程统一写 logs/pet.log）
  log: (level: 'warn' | 'error', message: string) => ipcRenderer.send('pet:log', { level, message }),
  onChange: (cb: (state: unknown) => void) => {
    ipcRenderer.on('settings:changed', (_e, state) => cb(state))
  },
})
