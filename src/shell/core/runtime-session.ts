import { PostMessageExecutor } from './bridge-executor';

export type RuntimeState = 'loading' | 'ready' | 'error' | 'disposed';
export type RuntimePresentation = { status: string; tone: 'working' | 'connected' | 'error' };

export function runtimePresentation(state: RuntimeState): RuntimePresentation {
  if (state === 'ready') return { status: 'App connected', tone: 'connected' };
  if (state === 'loading') return { status: 'App connecting', tone: 'working' };
  return { status: state === 'error' ? 'App runtime error' : 'App disconnected', tone: 'error' };
}

/** Owns the single live iframe/executor pair and its explicit handshake state. */
export class RuntimeSession {
  frame: HTMLIFrameElement | undefined;
  executor: PostMessageExecutor | undefined;
  state: RuntimeState = 'disposed';
  appSlug: string | undefined;
  origin: string | undefined;

  constructor(private readonly mount: (frame: HTMLIFrameElement) => void) {}

  switchTo(appSlug: string, origin: string): HTMLIFrameElement {
    this.dispose();
    const frame = document.createElement('iframe');
    frame.allow = 'camera; microphone; geolocation; clipboard-read; clipboard-write';
    frame.referrerPolicy = 'strict-origin';
    frame.src = origin;
    this.frame = frame;
    this.appSlug = appSlug;
    this.origin = origin;
    this.state = 'loading';
    this.executor = new PostMessageExecutor(frame, appSlug, origin);
    this.mount(frame);
    return frame;
  }

  setState(state: Exclude<RuntimeState, 'disposed'>): void {
    if (this.state !== 'disposed') this.state = state;
  }

  requireReady(): PostMessageExecutor {
    if (!this.frame?.isConnected || !this.executor || this.state === 'disposed') throw new Error('App runtime is unavailable');
    if (this.state !== 'ready') throw new Error(this.state === 'error' ? 'App runtime is in an error state' : 'App runtime is not ready yet');
    return this.executor;
  }

  dispose(): void {
    this.executor?.dispose();
    this.frame?.remove();
    this.executor = undefined;
    this.frame = undefined;
    this.appSlug = undefined;
    this.origin = undefined;
    this.state = 'disposed';
  }
}
