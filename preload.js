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
  skinRendered: () => ipcRenderer.send('bobo:skin-rendered')
})
