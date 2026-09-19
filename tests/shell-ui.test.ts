// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellUI, friendlyError, type AppSummary, type ShellActions } from '../src/shell/ui';

const app: AppSummary = { id: '550e8400-e29b-41d4-a716-446655440003', name: 'FiddleMate' };
const other: AppSummary = { id: '550e8400-e29b-41d4-a716-446655440004', name: 'Budget Pal' };

function actions(): ShellActions {
  return {
    createApp: vi.fn().mockResolvedValue(undefined), selectApp: vi.fn().mockResolvedValue(undefined), deleteApp: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined), stopAgent: vi.fn(), resumePausedRun: vi.fn().mockResolvedValue(undefined),
    resolveInteractionPrompt: vi.fn().mockResolvedValue(undefined), saveSettings: vi.fn().mockResolvedValue(undefined),
    refreshUsage: vi.fn().mockResolvedValue(undefined), renameApp: vi.fn().mockResolvedValue(undefined),
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
    expect(document.querySelector('.empty-chat')?.textContent).toContain('What should we change?');
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
    ui.setMessages([{ role: 'user', content: 'Create a metronome' }]);
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

  it('starts creating from the submitted prompt without a confirmation step', async () => {
    const { callbacks, ui } = mounted(false);
    ui.setSettings({ apiKey: 'configured' });
    document.querySelector<HTMLButtonElement>('[data-create]')!.click();
    const goal = document.querySelector<HTMLTextAreaElement>('#goal')!;
    goal.value = 'Help plan meals';
    document.querySelector<HTMLFormElement>('[data-create-form]')!.requestSubmit();

    await vi.waitFor(() => expect(callbacks.createApp).toHaveBeenCalledWith('Help plan meals'));
    expect(callbacks.createApp).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-create-status]')?.textContent).toContain('Starting your app');
  });

  it('advances first-time provider setup directly into app creation', async () => {
    const callbacks = actions();
    const ui = new ShellUI(document.querySelector('#app')!, callbacks);
    ui.setApps([]);
    document.querySelector<HTMLButtonElement>('[data-create]')!.click();
    const apiKey = document.querySelector<HTMLInputElement>('#apiKey')!;
    apiKey.value = 'test-key';
    document.querySelector<HTMLFormElement>('[data-settings-form]')!.requestSubmit();

    await vi.waitFor(() => expect(callbacks.saveSettings).toHaveBeenCalledWith({ apiKey: 'test-key', historyContextTokens: 12_000 }));
    await vi.waitFor(() => expect(document.querySelector('h1')?.textContent).toBe('What do you want to make?'));
  });

  it('exposes the history budget experiment without exposing provider internals', async () => {
    const { callbacks, ui } = mounted();
    document.querySelector<HTMLButtonElement>('[data-settings]')!.click();

    expect(document.querySelector('h2')?.textContent).toBe('OpenRouter');
    expect(document.querySelector('#provider')).toBeNull();
    expect(document.querySelector('#model')).toBeNull();
    expect(document.querySelector('#endpoint')).toBeNull();
    expect(document.querySelector('#contextTokens')).toBeNull();
    expect(document.querySelector('#outputTokens')).toBeNull();
    expect(document.querySelector<HTMLInputElement>('#historyContextTokens')?.value).toBe('12000');
    expect(document.querySelector<HTMLButtonElement>('button[type=submit]')?.textContent).toBe('Save');
    expect(document.querySelector('[data-build-commit]')?.textContent).toBe('development');

    const apiKey = document.querySelector<HTMLInputElement>('#apiKey')!;
    apiKey.value = 'sk-or-v1-test';
    document.querySelector<HTMLInputElement>('#historyContextTokens')!.value = '4000';
    document.querySelector<HTMLFormElement>('[data-settings-form]')!.requestSubmit();

    await vi.waitFor(() => expect(callbacks.saveSettings).toHaveBeenCalledWith({ apiKey: 'sk-or-v1-test', historyContextTokens: 4000 }));
    expect(document.querySelector('h1')?.textContent).toBe('Settings');
    expect(document.querySelector('[data-result]')?.textContent).toContain('OpenRouter connection works');
    ui.setModelContextCapacity(1_000_000);
    expect(document.querySelector('[data-model-context]')?.textContent).toContain('1,000,000 tokens');
  });

  it('shows session spend, context, and key usage as separate usage concepts', () => {
    const { ui, callbacks } = mounted();
    ui.setUsage({
      requests: 4,
      inputTokens: 12_000,
      outputTokens: 3_000,
      cost: 0.0123,
      costComplete: false,
      latestContextTokens: 4_200,
      contextCapacity: 1_000_000,
      keyUsage: 2.5,
      keyLimitRemaining: 7.5,
    });

    const button = document.querySelector<HTMLButtonElement>('[data-usage]')!;
    expect(button.getAttribute('aria-label')).toContain('$0.0123+');
    button.click();

    expect(callbacks.refreshUsage).toHaveBeenCalledOnce();
    const popover = document.querySelector('[data-usage-popover]')!;
    expect(popover.textContent).toContain('This session');
    expect(popover.textContent).toContain('Known session cost');
    expect(popover.textContent).toContain('$0.0123+ known');
    expect(popover.textContent).toContain('Current context');
    expect(popover.textContent).toContain('Key spend');
    expect(popover.textContent).toContain('Key remaining');
  });

  it('closes the usage disclosure when another shell menu opens', () => {
    const { ui } = mounted();
    ui.setUsage({ requests: 1, inputTokens: 100, outputTokens: 20, costComplete: false });
    document.querySelector<HTMLButtonElement>('[data-usage]')!.click();
    expect(document.querySelector('[data-usage-popover]')).not.toBeNull();

    document.querySelector<HTMLButtonElement>('[data-switcher]')!.click();
    expect(document.querySelector('[data-usage-popover]')).toBeNull();
    expect(document.querySelector('.app-switcher')).not.toBeNull();
  });

  it('keeps launcher and API-key copy concise', () => {
    mounted(false);
    expect(document.querySelector('.panel-heading')?.textContent).not.toContain('Workspace');
    expect(document.querySelector('h1')?.textContent).toBe('Your apps');

    document.querySelector<HTMLButtonElement>('[data-settings]')!.click();
    const note = document.querySelector('.security-note')?.textContent ?? '';
    expect(note).toContain('Stored locally in this browser');
    expect(note).toContain('never shared with generated apps');
    expect(note).toContain('shared devices');
  });

  it('routes creation to Settings until an LLM is configured', () => {
    mounted(false);
    document.querySelector<HTMLButtonElement>('[data-create]')!.click();
    expect(document.querySelector('h1')?.textContent).toBe('Settings');
    expect(document.querySelector('.panel-heading p')?.textContent).toContain('Add and test your OpenRouter API key');
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

  it('requires a concrete intent before confirming an interaction adaptation', () => {
    const { ui, callbacks } = mounted();
    ui.setInteractionPrompt({
      id: 'reaction-1',
      content: 'What were you trying to make happen?',
      intentPlaceholder: 'Describe what you expected to happen…',
      confirmLabel: 'Use this intent',
      dismissLabel: 'Not now',
    });

    expect(document.querySelectorAll('[data-interaction-prompt]')).toHaveLength(1);
    const intent = document.querySelector<HTMLTextAreaElement>('[data-prompt-intent]')!;
    const confirm = document.querySelector<HTMLButtonElement>('[data-prompt-confirm]')!;
    expect(intent.placeholder).toContain('Describe what you expected');
    expect(confirm.disabled).toBe(true);

    intent.value = 'Copy the current timer value';
    intent.dispatchEvent(new Event('input', { bubbles: true }));
    expect(confirm.disabled).toBe(false);
    confirm.click();
    expect(callbacks.resolveInteractionPrompt).toHaveBeenCalledWith('reaction-1', 'Copy the current timer value');
  });

  it('lets an interaction clarification be dismissed without sending a normal chat message', () => {
    const { ui, callbacks } = mounted();
    ui.setInteractionPrompt({
      id: 'reaction-2',
      content: 'What were you trying to make happen?',
      intentPlaceholder: 'Describe what you expected to happen…',
      confirmLabel: 'Use this intent',
      dismissLabel: 'Not now',
    });

    document.querySelector<HTMLButtonElement>('[data-prompt-dismiss]')!.click();
    expect(callbacks.resolveInteractionPrompt).toHaveBeenCalledWith('reaction-2', undefined);
    expect(callbacks.sendMessage).not.toHaveBeenCalled();
  });

  it('defers interaction clarification while another agent run is busy', () => {
    const { ui } = mounted();
    ui.setInteractionPrompt({
      id: 'reaction-busy',
      content: 'What were you trying to make happen?',
      intentPlaceholder: 'Describe what you expected to happen…',
      confirmLabel: 'Use this intent',
      dismissLabel: 'Not now',
    });
    expect(document.querySelector('[data-interaction-prompt]')).not.toBeNull();

    ui.setBusy(true);
    expect(document.querySelector('[data-interaction-prompt]')).toBeNull();

    ui.setBusy(false);
    expect(document.querySelector('[data-interaction-prompt]')).not.toBeNull();
  });

  it('replaces Send with a Stop control while the agent is busy', () => {
    const { ui, callbacks } = mounted();
    ui.setBusy(true);
    ui.setAgentProgress('Planning your change…');

    expect(document.querySelector<HTMLButtonElement>('[data-stop]')).not.toBeNull();
    expect(document.querySelector<HTMLButtonElement>('.send[type=submit]')).toBeNull();
    document.querySelector<HTMLButtonElement>('[data-stop]')!.click();
    expect(callbacks.stopAgent).toHaveBeenCalledOnce();
    expect(document.querySelector<HTMLButtonElement>('[data-stop]')!.disabled).toBe(true);
  });

  it('offers Continue change for a paused app run', () => {
    const { ui, callbacks } = mounted();
    ui.setResumePrompt({
      id: 'paused-1',
      content: 'Work paused because you switched apps. Changes already applied were kept.',
      actionLabel: 'Continue change',
    });

    expect(document.querySelector('[data-resume-prompt]')?.textContent).toContain('Work paused');
    document.querySelector<HTMLButtonElement>('[data-resume-run]')!.click();
    expect(callbacks.resumePausedRun).toHaveBeenCalledWith('paused-1');
  });

  it('shows one primary busy status plus a subtle app-update badge', () => {
    const { ui } = mounted();
    ui.setBusy(true);
    ui.setAgentProgress('Updating the app…', true);

    expect(document.querySelectorAll('.working-state')).toHaveLength(1);
    expect(document.querySelector('.working-state')?.textContent).toContain('Updating the app');
    expect(document.querySelector('[data-stream]')?.lastElementChild?.classList.contains('working-state')).toBe(true);
    expect(document.querySelector('.panel > .working-state')).toBeNull();
    expect(document.querySelector('.thinking')).toBeNull();
    expect(document.querySelector('[data-stage-state]')?.textContent).toContain('Updating the app');
    expect(document.querySelector('[data-stage-state]')?.classList.contains('updating')).toBe(true);

    ui.setBusy(false);
    expect(document.querySelector('.working-state')).toBeNull();
    expect(document.querySelector('[data-stage-state]')?.hasAttribute('hidden')).toBe(true);
  });

  it('keeps runtime problems visible even while agent busy state changes', () => {
    const { ui } = mounted();
    ui.setConnectionStatus('error');
    ui.setBusy(true);
    ui.setAgentProgress('Updating the app…', true);

    expect(document.querySelector('[data-stage-state]')?.textContent).toContain("couldn't load");
    expect(document.querySelector('[data-stage-state]')?.classList.contains('updating')).toBe(false);
    ui.setBusy(false);
    expect(document.querySelector('[data-stage-state]')?.hasAttribute('hidden')).toBe(false);
  });
});

describe('friendlyError', () => {
  it('maps implementation errors to product language', () => {
    expect(friendlyError('App iframe is not available', 'FiddleMate')).toBe("FiddleMate isn't ready yet. Try reloading it.");
    expect(friendlyError('Runtime request timed out', 'FiddleMate')).toBe('FiddleMate took too long to respond. Try again.');
  });
});
