// 桌宠「直接对话」窗口的受限桥（2026-10-24）。
//
// 只给四类事：读一次快照、发一句（可带文件路径）、选文件、关掉自己（外加跳到开发工单）。
// 没有"选会话"这个口子 —— 这条窗口只连主人自己的会话（private:<机器人自己的QQ号>），
// 从接口层面就不给它往别的群发消息的能力。
// 文件只过**路径**：内容由后端按需读，渲染进程不接触字节，也拿不到任何读写能力。
// 不暴露 ipcRenderer、不暴露 fetch/文件系统/模型凭据。
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('qqPetChat', Object.freeze({
  ready: () => ipcRenderer.send('qqa-chat:ready'),
  snapshot: () => ipcRenderer.invoke('qqa-chat:snapshot'),
  send: (text, files = []) => ipcRenderer.invoke('qqa-chat:send', {
    text: String(text || '').slice(0, 2000),
    files: (Array.isArray(files) ? files : []).slice(0, 8).map((f) => ({
      path: String(f?.path || ''),
      name: String(f?.name || ''),
      size: Number(f?.size) || 0
    }))
  }),
  // 加号：主进程弹原生文件选择框（可多选）
  pickFiles: () => ipcRenderer.invoke('qqa-chat:pick-files'),
  // 拖放：把 File 对象换成磁盘路径（只回路径，不给读写能力）
  pathForFile: (file) => ipcRenderer.invoke('qqa-chat:path-for', file),
  hide: () => ipcRenderer.send('qqa-chat:hide'),
  openDev: () => ipcRenderer.send('qqa-chat:open-dev'),
  onTyping: (callback) => subscribe('qqa-chat:typing', callback),
  onRefresh: (callback) => subscribe('qqa-chat:refresh', callback),
}));
