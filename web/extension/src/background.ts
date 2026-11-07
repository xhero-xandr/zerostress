// A right-click on a link opens the agent's side panel and hands it the link; the panel starts the check, since the
// person chose it from the menu. The extension never reads a page: it only sees the link it is given.
import { webLink } from './link.ts';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'zs-link', title: 'Check this link in a sandbox (ZeroStress)', contexts: ['link'] });
  chrome.contextMenus.create({ id: 'zs-page', title: 'Check this page’s address in a sandbox (ZeroStress)', contexts: ['page'] });
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const link = webLink(info.menuItemId === 'zs-link' ? info.linkUrl : info.pageUrl);
  if (!link || tab?.windowId === undefined) return;
  // open first, inside the user's gesture; the panel picks the link up from session storage (or the message below)
  void chrome.sidePanel.open({ windowId: tab.windowId });
  void chrome.storage.session.set({ handoff: { link, at: Date.now() } });
  chrome.runtime.sendMessage({ type: 'zs-check', link }).catch(() => { /* the panel is not open yet: it reads the handoff */ });
});
