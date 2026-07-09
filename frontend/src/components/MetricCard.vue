<script setup lang="ts">
import AppIcon from './AppIcon.vue';
defineProps<{
  label: string;
  value: string;
  detail: string;
  tone?: 'primary' | 'good' | 'warn' | 'bad';
  icon?: string;
}>();
</script>
<template>
  <article class="metric-card">
    <div class="metric-top">
      <span>{{ label }}</span
      ><span class="metric-icon" :class="tone || 'primary'"
        ><AppIcon :name="icon || 'chart'" :size="18"
      /></span>
    </div>
    <strong>{{ value }}</strong
    ><small>{{ detail }}</small>
  </article>
</template>
