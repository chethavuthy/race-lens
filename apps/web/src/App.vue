<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router';
</script>

<template>
  <div class="wrap">
    <header class="site-head">
      <RouterLink to="/" class="brand">Race<span>Lens</span></RouterLink>
      <RouterLink to="/admin" class="muted small">Organizer</RouterLink>
    </header>
    <RouterView />
  </div>
</template>
