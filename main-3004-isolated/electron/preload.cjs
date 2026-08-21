const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopCredentials', {
  load: () => ipcRenderer.sendSync('desktop-credentials:load'),
  save: credentials => ipcRenderer.sendSync('desktop-credentials:save', credentials),
});

contextBridge.exposeInMainWorld('desktopRuntime', {
  isElectron: true,
  chooseDirectory: () => ipcRenderer.invoke('desktop:choose-directory'),
  saveGeneratedImage: payload => ipcRenderer.invoke('desktop:save-generated-image', payload),
});
