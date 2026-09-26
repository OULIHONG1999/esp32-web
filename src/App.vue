<script setup lang="ts">
import EnvCheck from './components/EnvCheck.vue'
import { ref } from 'vue'
import { checkEnvironment, type EnvReport } from './env/environment'

const report = ref<EnvReport>(checkEnvironment())
</script>

<template>
  <div class="shell">
    <header class="shell__header">
      <span class="shell__brand">ESP32 Web Flasher</span>
      <span class="shell__hint">v0.1.0 · T1/T2</span>
    </header>
    <main class="shell__main">
      <EnvCheck :report="report" @recheck="report = checkEnvironment()" />
    </main>
  </div>
</template>
