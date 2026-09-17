// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellUI, type AppSummary, type ShellActions } from '../src/shell/ui';

const app: AppSummary = { slug: 'fiddlemate', name: 'FiddleMate', prompt: 'Build music tools', createdAt: 1, updatedAt: 1 };
const actions: ShellActions = {
  createApp: vi.fn(), selectApp: vi.fn(), deleteApp: vi.fn(), updatePrompt: vi.fn(), sendMessage: vi.fn(), saveSettings: vi.fn(),
  designApp: vi.fn(), exportLogs: vi.fn(), reloadApp: vi.fn(),
};

describe('ShellUI persistent app stage', () => {
  beforeEach(() => { document.body.innerHTML = '<div id="app"></div>'; localStorage.clear(); });

  function mounted() {
    const ui = new ShellUI(document.querySelector('#app')!, actions);
    ui.setApps([app], app.slug);
    const frame = document.createElement('iframe');
    ui.mountFrame(frame);
    return { ui, frame };
  }

  it('does not destroy the iframe when chat messages change', () => {
    const { ui, frame } = mounted();
    ui.setMessages([{ id: '1', role: 'user', content: 'Create a metronome', timestamp: 1 }]);
    expect(document.querySelector('.app-frame-wrap iframe')).toBe(frame);
    expect(frame.isConnected).toBe(true);
  });

  it('keeps the exact iframe across tabs, theme, settings, and sidebar changes', () => {
    const { frame } = mounted();
    for (const selector of ['[data-tab="apps"]', '[data-theme]', '[data-settings]', '[data-collapse]']) {
      document.querySelector<HTMLButtonElement>(selector)!.click();
      expect(document.querySelector('.app-frame-wrap iframe')).toBe(frame);
    }
  });
});
