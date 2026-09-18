// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellUI, friendlyError, type AppSummary, type ShellActions } from '../src/shell/ui';

const app: AppSummary = { id: '550e8400-e29b-41d4-a716-446655440003', name: 'FiddleMate', prompt: 'Build music tools', createdAt: 1, updatedAt: 1 };
const other: AppSummary = { id: 'budget-pal-secret-id', name: 'Budget Pal', prompt: 'Budgeting', createdAt: 2, updatedAt: 2 };

function actions(): ShellActions {
  return {
    createApp: vi.fn().mockResolvedValue(undefined), selectApp: vi.fn().mockResolvedValue(undefined), deleteApp: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined), saveSettings: vi.fn().mockResolvedValue(undefined),
    renameApp: vi.fn().mockResolvedValue(undefined),
    designApp: vi.fn().mockResolvedValue({ name: 'Recipe Buddy', prompt: 'Plan friendly meals' }),
    exportLogs: vi.fn().mockResolvedValue(undefined), reloadApp: vi.fn(),
  };
}

describe('ShellUI workspace', () => {
  beforeEach(() => { document.body.innerHTML = '<div id="app"></div>'; localStorage.clear(); vi.restoreAllMocks(); });

  function mounted(selected = true) {
    const callbacks = actions();
    const ui = new ShellUI(document.querySelector('#app')!, callbacks);
    ui.setApps([app, other], selected ? app.id : undefined);
    const frame = document.createElement('iframe');
    if (selected) ui.mountFrame(frame);
    return { ui, frame, callbacks };
  }

  it('opens a selected app directly in chat without desktop Apps/Chat tabs', () => {
    mounted();
    expect(document.querySelector('[data-composer]')).not.toBeNull();
    expect(document.querySelector('.tabs')).toBeNull();
    expect(document.querySelector('.empty-chat')?.textContent).toContain('Make FiddleMate yours');
  });

  it('switches apps from the header and shows names without technical identifiers', () => {
    const { callbacks } = mounted();
    document.querySelector<HTMLButtonElement>('[data-switcher]')!.click();
    const switcher = document.querySelector('.app-switcher')!;
    expect(switcher.textContent).toContain('Budget Pal');
    expect(switcher.textContent).not.toContain(other.id);
    document.querySelector<HTMLButtonElement>(`[data-select-app="${other.id}"]`)!.click();
    expect(callbacks.selectApp).toHaveBeenCalledWith(other.id);
  });

  it('does not destroy the iframe during ordinary sidebar interactions', () => {
    const { ui, frame } = mounted();
    ui.setMessages([{ id: '1', role: 'user', content: 'Create a metronome', timestamp: 1 }]);
    for (const selector of ['[data-switcher]', '[data-theme]', '[data-settings]', '[data-collapse]']) {
      document.querySelector<HTMLButtonElement>(selector)!.click();
      expect(document.querySelector('.app-frame-wrap iframe')).toBe(frame);
    }
  });

  it('persists collapse state and keeps the top collapse control available', () => {
    mounted();
    document.querySelector<HTMLButtonElement>('[data-collapse]')!.click();
    expect(localStorage.getItem('itsalive.sidebar')).toBe('collapsed');
    expect(document.querySelector('.workspace-header > [data-collapse]')).not.toBeNull();
  });

  it('keeps reload and confirmed delete in the app actions menu', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { callbacks } = mounted();
    document.querySelector<HTMLButtonElement>('[data-app-menu]')!.click();
    document.querySelector<HTMLButtonElement>('[data-reload]')!.click();
    expect(callbacks.reloadApp).toHaveBeenCalledOnce();
    document.querySelector<HTMLButtonElement>('[data-app-menu]')!.click();
    document.querySelector<HTMLButtonElement>('[data-delete]')!.click();
    expect(callbacks.deleteApp).toHaveBeenCalledWith(app.id);
  });

  it('does not expose the generated id in a creation proposal', async () => {
    const { callbacks, ui } = mounted(false);
    ui.setSettings({ apiKey: 'configured' });
    document.querySelector<HTMLButtonElement>('[data-create]')!.click();
    const goal = document.querySelector<HTMLTextAreaElement>('#goal')!;
    goal.value = 'Help plan meals';
    document.querySelector<HTMLFormElement>('[data-create-form]')!.requestSubmit();
    await vi.waitFor(() => expect(document.querySelector('.creation-proposal')).not.toBeNull());
    expect(document.querySelector('.creation-proposal')?.textContent).toContain('Recipe Buddy');
    expect(document.querySelector('.creation-proposal')?.textContent).not.toContain('recipe-buddy-secret');
    expect(callbacks.designApp).toHaveBeenCalledWith('Help plan meals');
  });

  it('offers DeepSeek as a first-class provider', () => {
    mounted();
    document.querySelector<HTMLButtonElement>('[data-settings]')!.click();
    expect([...document.querySelectorAll<HTMLOptionElement>('#provider option')].map(option => option.value)).toContain('deepseek');
  });

  it('routes creation to Settings until an LLM is configured', () => {
    mounted(false);
    document.querySelector<HTMLButtonElement>('[data-create]')!.click();
    expect(document.querySelector('h1')?.textContent).toBe('Settings');
    expect(document.querySelector('.panel-heading p')?.textContent).toContain('Configure and test a model');
  });

  it('renames from the app menu without changing app identity', () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('New Fiddle Name');
    const { callbacks } = mounted();
    document.querySelector<HTMLButtonElement>('[data-app-menu]')!.click();
    document.querySelector<HTMLButtonElement>('[data-rename]')!.click();
    expect(prompt).toHaveBeenCalledWith('Rename app', app.name);
    expect(callbacks.renameApp).toHaveBeenCalledWith('New Fiddle Name');
    expect(callbacks.selectApp).not.toHaveBeenCalled();
  });

  it('keeps agent busy state independent from runtime connection state', () => {
    const { ui } = mounted();
    ui.setConnectionStatus('App runtime error', 'error');
    ui.setBusy(true);
    expect(document.querySelector('.working-state')?.textContent).toContain('Working');
    expect(document.querySelector('[data-stage-state]')?.hasAttribute('hidden')).toBe(false);
    ui.setBusy(false);
    expect(document.querySelector('.working-state')).toBeNull();
    expect(document.querySelector('[data-stage-state]')?.hasAttribute('hidden')).toBe(false);
  });
});

describe('friendlyError', () => {
  it('maps implementation errors to product language', () => {
    expect(friendlyError('App iframe is not available', 'FiddleMate')).toBe("FiddleMate isn't ready yet. Try reloading it.");
    expect(friendlyError('Runtime request timed out', 'FiddleMate')).toBe('FiddleMate took too long to respond. Try again.');
  });
});
