import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Pages serves the site under the repo name, so VITE_BASE sets the path it lives at.
export default defineConfig({ base: process.env.VITE_BASE ?? "/", plugins: [react()] });
