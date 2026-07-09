<script setup lang="ts">
import { useRoute } from 'vue-router';
import AppShell from './layouts/AppShell.vue';
const route = useRoute();
</script>

<template><RouterView v-if="route.meta.publicLayout" /><AppShell v-else /></template>
