<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { api, type EventSummary } from '../lib/api';
import { formatDate, plural } from '../lib/format';
import { eventListCache } from '../lib/cache';

// Read during setup, so coming back from an album re-renders the same list
// instead of replacing it with skeleton cards for a second. See lib/cache.ts.
const restored = eventListCache.read('events');

const events = ref<EventSummary[]>(restored ?? []);
const loading = ref(!restored);
const error = ref<string | null>(null);

onMounted(async () => {
  if (restored) return;
  try {
    events.value = (await api.listEvents()).events;
    eventListCache.write('events', events.value);
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <!--
    The front door.

    This page gets more traffic than any other and used to do the least work: a
    list of cards and one sentence. The three facts below are the ones that
    decide whether a stranger will try the search at all — that it is free, that
    their face never leaves their phone, and that it still works when their bib
    doesn't. None of them were stated anywhere.
  -->
  <header class="masthead">
    <h1>Find yourself in the race photos.</h1>
    <p class="lede">
      Pick your event, then search by the number you wore or by your own face.
      It takes about ten seconds.
    </p>
  </header>

  <div class="assurances">
    <div>
      <h3>Free, and no account</h3>
      <p>Every photo opens full-size from the photographer's own album. There is nothing to sign up for.</p>
    </div>
    <div>
      <h3>Your face stays on your phone</h3>
      <p>The matching runs in your browser. Your selfie is never uploaded and never stored.</p>
    </div>
    <div>
      <h3>Works when your bib doesn't</h3>
      <p>Numbers get folded, covered, or turned away from the camera. Face search doesn't mind.</p>
    </div>
  </div>

  <div class="section-head">
    <h2>Events</h2>
    <span v-if="!loading && events.length" class="muted small">
      {{ plural(events.length, 'album') }} published
    </span>
  </div>

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
      <div class="banner">
        <!-- The blurred backdrop is the same picture, so it is decorative:
             announcing it twice would only be noise to a screen reader. -->
        <template v-if="e.banner_url">
          <img class="banner-fill" :src="e.banner_url" alt="" aria-hidden="true" loading="lazy" />
          <img class="banner-img" :src="e.banner_url" alt="" loading="lazy" />
        </template>
      </div>
      <div class="body">
        <div class="name">{{ e.name }}</div>
        <div class="muted small">
          <span v-if="e.event_date">{{ formatDate(e.event_date) }} · </span>
          {{ plural(e.photo_count, 'photo') }}
          · {{ e.bibs_enabled ? 'Bib or face' : 'Face search' }}
          <span v-if="e.status === 'partial'"> · still growing</span>
        </div>
      </div>
    </RouterLink>
  </div>
</template>
