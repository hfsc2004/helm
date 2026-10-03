// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Pseudo Science Fiction
import { mount } from "svelte";
import App from "./App.svelte";
import LightScriptEditor from "./components/LightScriptEditor.svelte";
import "./app.css";

const target = document.getElementById("app");
if (!target) throw new Error("Mount point #app not found");

const app = mount(window.location.hash.startsWith("#led-editor") ? LightScriptEditor : App, { target });

export default app;
