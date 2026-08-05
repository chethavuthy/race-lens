<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { api, type EventSummary } from '../lib/api';

const events = ref<EventSummary[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

function formatDate(iso: string | null) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

onMounted(async () => {
  try {
    events.value = (await api.listEvents()).events;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <h1>Find your race photos</h1>
  <p class="lede">Pick your event, then search by bib number, selfie, or a photo of yourself.</p>

  <!-- Skeleton cards hold the grid's real shape so nothing reflows on arrival. -->
  <div v-if="loading" class="event-grid" aria-hidden="true">
    <div v-for="i in 3" :key="i" class="event-card">
      <div class="skeleton" style="aspect-ratio: 16 / 9; border-radius: 0" />
      <div class="body">
        <div class="skeleton skeleton-line" style="width: 70%" />
        <div class="skeleton skeleton-line short" />
      </div>
    </div>
  </div>
  <p v-if="loading" class="sr-only" role="status">Loading events</p>

  <p v-else-if="error" class="notice err">{{ error }}</p>

  <div v-else-if="!events.length" class="card">
    <h2>No events published yet</h2>
    <p class="muted" style="margin-top: 0">
      Photos appear here once an organizer has uploaded and indexed an album — usually a few
      days after race day.
    </p>
    <p class="muted small" style="margin-bottom: 0">
      Organizing a race? <RouterLink to="/admin" style="text-decoration: underline">Publish your album</RouterLink>.
    </p>
  </div>

  <div v-else class="event-grid stagger">
    <RouterLink
      v-for="(e, i) in events" :key="e.id"
      :to="`/e/${e.slug}`" class="event-card" :style="{ '--i': i }">
      <img v-if="e.banner_url" class="banner" :src="e.banner_url" alt="" loading="lazy" />
      <div v-else class="banner" />
      <div class="body">
        <div class="name">{{ e.name }}</div>
        <div class="muted small">
          <span v-if="e.event_date">{{ formatDate(e.event_date) }} · </span>
          {{ e.photo_count.toLocaleString() }} photos
          <span v-if="e.status === 'partial'"> · still growing</span>
        </div>
      </div>
    </RouterLink>
  </div>
</template>
