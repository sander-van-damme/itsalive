// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { RuntimeSession, runtimePresentation } from '../src/shell/core/runtime-session';

describe('RuntimeSession', () => {
  beforeEach(() => { document.body.innerHTML = '<div id="stage"></div>'; });

  const createSession = () => new RuntimeSession(frame => document.querySelector('#stage')!.replaceChildren(frame));

  it('intentionally disposes the old iframe and executor when switching apps', () => {
    const session = createSession();
    const first = session.switchTo('app-a', 'https://app-a.itsalive.org');
    const firstExecutor = session.executor;
    const second = session.switchTo('app-b', 'https://app-b.itsalive.org');
    expect(first.isConnected).toBe(false);
    expect(second.isConnected).toBe(true);
    expect(session.executor).not.toBe(firstExecutor);
    expect(session.appSlug).toBe('app-b');
    expect(session.state).toBe('loading');
  });

  it('blocks execution until the runtime ready handshake', () => {
    const session = createSession();
    session.switchTo('fiddlemate', 'https://fiddlemate.itsalive.org');
    expect(() => session.requireReady()).toThrow('App runtime is not ready yet');
    session.setState('ready');
    expect(session.requireReady()).toBe(session.executor);
  });

  it('does not describe an errored runtime as connected after an agent run', () => {
    expect(runtimePresentation('error')).toEqual({ status: 'App runtime error', tone: 'error' });
    expect(runtimePresentation('disposed')).toEqual({ status: 'App disconnected', tone: 'error' });
    expect(runtimePresentation('ready')).toEqual({ status: 'App connected', tone: 'connected' });
  });
});
