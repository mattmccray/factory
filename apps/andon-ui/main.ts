// The browser entry: mounts the board, or (in the Mac app's Settings window, `?shell=mac&view=settings`)
// the settings view, or (in its About window, `?shell=mac&view=about`) the about view, or (in its desk
// widget window, `?shell=mac&view=widget`) the desk widget. It lives
// outside src/ because it touches the DOM; the logic in src/*.ts stays DOM-free and runs under `bun test`.
import { mount } from 'svelte';
import About from './src/About.svelte';
import App from './src/App.svelte';
import DeskWidget from './src/DeskWidget.svelte';
import Settings from './src/Settings.svelte';
import { appView } from './src/sidebar';
import './src/app.css';

const view = appView(window.location.search);
mount(view === 'settings' ? Settings : view === 'about' ? About : view === 'widget' ? DeskWidget : App, { target: document.body });
