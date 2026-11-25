'use strict';
const CHANNEL = 'personal-history-guard:v2';
function install({ contextBridge, ipcRenderer }) {
  contextBridge.exposeInMainWorld('personalHistoryGuard', Object.freeze({
    version: 2,
    getSnapshot: () => ipcRenderer.sendSync(`${CHANNEL}:snapshot`),
    subscribe: callback => {
      if (typeof callback !== 'function') throw new TypeError('A callback is required');
      const listener = (_event, snapshot) => callback(snapshot);
      ipcRenderer.on(`${CHANNEL}:changed`, listener);
      return () => ipcRenderer.removeListener(`${CHANNEL}:changed`, listener);
    },
    resetApprovals: password => typeof password === 'string' && password.length <= 1024 ? ipcRenderer.invoke(`${CHANNEL}:reset`, password) : Promise.resolve(false)
  }));
}
module.exports = { install };
