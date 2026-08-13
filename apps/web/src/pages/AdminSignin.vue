<script setup lang="ts">
/**
 * The door, for people who already have a key.
 *
 * /admin is public so photographers can read the invitation, which means
 * opening it no longer triggers a Cloudflare Access login — and a signed-out
 * organizer would otherwise land on the invitation with no way past it. This
 * path IS covered by the Access application, so simply arriving here forces the
 * login; by the time this component renders, the cookie is set and /admin can
 * load its own data.
 *
 * router.replace, not a link: this page is a turnstile, and leaving it in the
 * history would send Back straight through it again.
 */
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();
onMounted(() => router.replace('/admin'));
</script>

<template>
  <p class="muted" style="margin-top: var(--s-6)"><span class="spinner" /> Signing you in…</p>
</template>
