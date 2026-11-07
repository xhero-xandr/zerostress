// The few extension APIs this extension uses, typed here instead of a dependency on @types/chrome.
declare namespace chrome {
  namespace runtime {
    const onInstalled: { addListener(cb: () => void): void };
    const onMessage: { addListener(cb: (msg: unknown) => void): void };
    function sendMessage(msg: unknown): Promise<unknown>;
  }
  namespace contextMenus {
    interface OnClickData { menuItemId: string | number; linkUrl?: string; pageUrl?: string }
    function create(p: { id: string; title: string; contexts: string[] }): void;
    const onClicked: { addListener(cb: (info: OnClickData, tab?: { windowId?: number; id?: number }) => void): void };
  }
  namespace sidePanel {
    function open(p: { windowId: number }): Promise<void>;
    function setPanelBehavior(p: { openPanelOnActionClick: boolean }): Promise<void>;
  }
  namespace storage {
    const session: { set(v: Record<string, unknown>): Promise<void>; get(k: string): Promise<Record<string, unknown>>; remove(k: string): Promise<void> };
  }
}
