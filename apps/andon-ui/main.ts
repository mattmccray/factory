// The browser entry: mounts the board, or (in the Mac app's Settings window, `?shell=mac&view=settings`)
// the settings view. It lives outside src/ because it touches the DOM; the logic in src/*.ts stays
// DOM-free and runs under `bun test`.
import { mount } from 'svelte';
import App from './src/App.svelte';
import Settings from './src/Settings.svelte';
import { appView } from './src/sidebar';
import './src/app.css';

mount(appView(window.location.search) === 'settings' ? Settings : App, { target: document.body });
