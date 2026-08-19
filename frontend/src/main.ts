import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import './style.css';
import './design-authority.css';
// Loads LAST, and that is the point: the vendored design-system files are the
// authority, so where an older hand-transcribed rule disagrees at equal
// specificity the package wins by order. See design-system/index.css.
import './design-system/index.css';

document.documentElement.dataset.theme =
  localStorage.getItem('jkannel-console-theme') === 'dark' ? 'dark' : 'light';

createApp(App).use(router).mount('#app');
