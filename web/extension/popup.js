import { checkUrl } from './link.js';

const input = document.getElementById('url');
const error = document.getElementById('error');

// the address of the tab the person is on, only after they clicked the button (activeTab), and only a web address
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (tab?.url && checkUrl(tab.url)) input.value = tab.url;
});

document.getElementById('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const target = checkUrl(input.value);
  error.hidden = target !== null;
  if (target) { chrome.tabs.create({ url: target }); window.close(); }
});
