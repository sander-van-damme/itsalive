const scenarios = [
  {
    id: "simple-initial-build",
    prompt: "Build a simple stopwatch with Start, Pause, Reset, and a visible elapsed time.",
    checks: ["visible UI", "primary controls work", "no permanent blocking", "behavior survives reload"],
  },
  {
    id: "movie-night",
    prompt: "Build me a personal movie night planner. I want to add movies with title, genre and duration, have a shortlist of movies I’m considering, and a separate ‘Tonight’ section where I can pick one. Make it visually polished and pleasant to use.",
    checks: ["add movie", "shortlist", "Tonight", "remove", "no probe records", "initial run completes"],
  },
  {
    id: "repair",
    prompt: "the app buttons don't work",
    checks: ["repair route", "existing user data preserved", "canonical state contract preserved", "controls work"],
  },
  {
    id: "word-decider",
    prompt: "make an app where I type in a word. if I click the decide button, it decides whether the word is in English or not",
    checks: ["application.ai.decide selected", "true/false/null handled", "visible interactive result"],
  },
  {
    id: "reload-and-modify",
    prompt: "Reload an interactive app after entering real data, verify state and controls, then request one small modification.",
    checks: ["state restored", "behavior restored", "modification preserves contract/data"],
  },
];

console.log("itsalive reliability live eval");
console.log("");
console.log("Keep constant:");
console.log("- current main build / same browser environment");
console.log("- Chrome incognito or equivalent clean session");
console.log("- OpenRouter route: openrouter/auto");
console.log("- History budget: 12,000 tokens");
console.log("- Cross-app preferences: off");
console.log("- same prompts and action sequence");
console.log("");
console.log("Before each run: use Settings > Agent profiles to record effective role compute and history.");
console.log("After each run: export session logs.");
console.log("");
for (const scenario of scenarios) {
  console.log("[" + scenario.id + "]");
  console.log("Prompt: " + scenario.prompt);
  console.log("Check: " + scenario.checks.join("; "));
  console.log("");
}
console.log("Record:");
console.log("- acceptance-criteria outcome and final lifecycle state");
console.log("- manager/worker request counts and repair loops");
console.log("- role/profile/model/compute");
console.log("- first useful execution and total wall time");
console.log("- completion/JEV decisions");
console.log("- configured/effective/selected/omitted history and context capacity");
console.log("- provider input/output/reasoning tokens and JEV usage");
console.log("");
console.log("Robustness probe: repeat a failing/important scenario with component-worker Low, Medium, then High while holding everything else constant.");
console.log("Do not use Extra High or Max. Keep history-budget experiments separate from this reliability run.");
console.log("Quality/reliability is the gate; do not impose token or cost targets.");
