<script lang="ts">
  import BrowseV3 from "./BrowseV3.svelte";
  let { presentation = "page" }: { presentation?: "page" | "embedded" } = $props();
</script>

<BrowseV3 {presentation} />
