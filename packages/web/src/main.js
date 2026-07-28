import { jsx as _jsx } from "react/jsx-runtime";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./theme.css";
const root = document.getElementById("root");
if (!root)
    throw new Error("index.html is missing #root");
createRoot(root).render(_jsx(StrictMode, { children: _jsx(App, {}) }));
