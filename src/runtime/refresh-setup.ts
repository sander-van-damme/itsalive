import * as Refresh from "react-refresh/runtime";

// This dependency must execute before react-dom/client is evaluated so the
// renderer registers with React Refresh's development hook.
Refresh.injectIntoGlobalHook(window);
