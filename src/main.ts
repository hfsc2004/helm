import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";

const target = document.getElementById("app");
if (!target) throw new Error("Mount point #app not found");

const app = mount(App, { target });

export default app;
