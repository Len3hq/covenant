import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/mona-sans";
import "@fontsource-variable/space-grotesk";
import "./styles.css";
import "./theme.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
