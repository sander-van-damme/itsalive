/** Public build provenance. No runtime configuration or credentials belong here. */
export interface BuildInfo {
  version: string;
  commit: string;
  subject: string;
  builtAt: string;
  dirty: boolean;
}
declare const __ITSALIVE_BUILD__: BuildInfo | undefined;
export const BUILD_INFO: BuildInfo =
  typeof __ITSALIVE_BUILD__ !== "undefined"
    ? __ITSALIVE_BUILD__
    : {
        version: "2.0.0-beta.2",
        commit: "unknown",
        subject: "",
        builtAt: "unknown",
        dirty: false,
      };

export function buildLabel(build = BUILD_INFO): string {
  const commit =
    build.commit === "unknown"
      ? "unidentified build"
      : build.commit.slice(0, 8);
  return `${build.version} · ${commit}${build.dirty ? " · local changes" : ""}`;
}
