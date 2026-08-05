import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import './styles.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./pages/EventList.vue') },
    { path: '/e/:slug', component: () => import('./pages/EventDetail.vue'), props: true },
    { path: '/admin', component: () => import('./pages/Admin.vue') },
    // Phase 5 acceptance gate. Dev builds only — never shipped to production.
    ...(import.meta.env.DEV
      ? [{ path: '/golden', component: () => import('./pages/Golden.vue') }]
      : []),
    { path: '/:pathMatch(.*)*', component: () => import('./pages/NotFound.vue') },
  ],
  scrollBehavior: () => ({ top: 0 }),
});

createApp(App).use(router).mount('#app');
