// The browser entry: mounts the board. It lives outside src/ because it touches the DOM; the
// board logic in src/*.ts stays DOM-free and runs under `bun test`.
import { mount } from 'svelte';
import App from './src/App.svelte';
import './src/app.css';

mount(App, { target: document.body });
