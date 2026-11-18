<!--
  The same stylesheet the fixture loads, used in a real component.
  Import it once, e.g. in main.ts:  import "../../dist/settings.css";
  Cascadio has no runtime: these are ordinary classes on ordinary elements.
-->
<script setup lang="ts">
defineEmits<{ save: []; cancel: [] }>();
</script>

<template>
  <section class="ca-settings-panel" aria-labelledby="notifications-title">
    <h2 id="notifications-title" class="ca-settings-panel__title">Email notifications</h2>
    <p class="ca-settings-panel__description">Pick what lands in your inbox.</p>
    <div class="ca-settings-panel__actions">
      <button class="ca-settings-panel__primary" type="submit" @click="$emit('save')">Save changes</button>
      <button class="ca-settings-panel__secondary" type="button" @click="$emit('cancel')">Cancel</button>
    </div>
  </section>
</template>
