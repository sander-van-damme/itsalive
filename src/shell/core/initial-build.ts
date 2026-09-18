/** Tracks one new app's build intent until an agent run has actually accepted it. */
export class InitialBuildIntent {
  private appId?: string;

  schedule(appId: string): void { this.appId = appId; }
  clear(appId: string): void { if (this.appId === appId) this.appId = undefined; }
  candidate(activeAppId: string | undefined, runtimeReady: boolean, agentRunning: boolean): string | undefined {
    return runtimeReady && !agentRunning && this.appId === activeAppId ? this.appId : undefined;
  }
  accepted(appId: string): void { this.clear(appId); }
}
