import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import './style.css';
import './design-authority.css';

document.documentElement.dataset.theme =
  localStorage.getItem('jkannel-console-theme') === 'dark' ? 'dark' : 'light';

createApp(App).use(router).mount('#app');
