// 卜卜宠物 · 预加载桥（安全暴露最小 API）
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bobo', {
  onAudioEnergy: (cb) => ipcRenderer.on('audio:energy', (_e, v) => cb(v)),
  onAudioBeat: (cb) => ipcRenderer.on('audio:beat', () => cb()),
  onAudioState: (cb) => ipcRenderer.on('audio:state', (_e, d) => cb(d)),
  moveDelta: (dx, dy) => ipcRenderer.send('bobo:move-delta', { dx, dy }),
  quit: () => ipcRenderer.send('bobo:quit'),
  selectPetNormal: () => ipcRenderer.invoke('bobo:select-pet-normal'),
  selectPetAngry: () => ipcRenderer.invoke('bobo:select-pet-angry'),
  getPetSkin: () => ipcRenderer.invoke('bobo:get-pet-skin'),
  skinRendered: () => ipcRenderer.send('bobo:skin-rendered'),
  // AI 任务监控：注入到 pet 窗口与 tasks 浮窗
  openAiTasks: () => ipcRenderer.send('bobo:open-ai-tasks'),
  getAiTasksInfo: () => ipcRenderer.invoke('bobo:ai-tasks-info'),
  onTasksUpdate: (cb) => ipcRenderer.on('tasks:update', (_e, d) => cb(d)),
  taskResize: (d) => ipcRenderer.send('tasks:resize', d),
  openToolApp: (key) => ipcRenderer.invoke('bobo:open-tool', key)
})
