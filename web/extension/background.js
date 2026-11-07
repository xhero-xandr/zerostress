import { checkUrl } from './link.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'zs-link', title: 'Check this link with ZeroStress', contexts: ['link'] });
  chrome.contextMenus.create({ id: 'zs-page', title: 'Check this page’s address with ZeroStress', contexts: ['page'] });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const target = checkUrl(info.menuItemId === 'zs-link' ? info.linkUrl : info.pageUrl);
  if (target) chrome.tabs.create({ url: target, ...(tab?.index !== undefined ? { index: tab.index + 1 } : {}) });
});
