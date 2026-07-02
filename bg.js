// 点击工具栏图标 → 通知当前标签页的 content script 召唤/收起面板
chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id) chrome.tabs.sendMessage(tab.id, { type: 'pb-toggle' }).catch(() => {});
});
