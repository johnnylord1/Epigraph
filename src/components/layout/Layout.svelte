<script lang="ts">
  import { store } from "../../store/state.svelte";
  import Sidebar        from "./Sidebar.svelte";
  import Home           from "../pages/Home.svelte";
  import Library        from "../pages/Library.svelte";
  import SeriesDetail   from "../pages/SeriesDetail.svelte";
  import BookDetail     from "../pages/BookDetail.svelte";
  import Search         from "../pages/Search.svelte";
  import Downloads      from "../pages/Downloads.svelte";

  const hasActiveBook = $derived(
    !!store.activeBookId && store.books.some((book) => book.id === store.activeBookId),
  );
</script>

<div class="root">
  <Sidebar />
  <main class="main">
    {#if store.navPage === "home"}
      <Home />
    {:else if store.navPage === "library"}
      <Library />
    {:else if store.navPage === "search"}
      <Search />
    {:else if store.navPage === "downloads"}
      <Downloads />
    {:else}
      <Home />
    {/if}

    {#if store.activeManga}
      <div class="detail-layer">
        <SeriesDetail />
      </div>
    {:else if hasActiveBook}
      <div class="detail-layer">
        <BookDetail />
      </div>
    {/if}
  </main>
</div>

<style>
  .root { display: flex; height: 100%; background: var(--bg-base); overflow: hidden; }
  .main { position: relative; flex: 1; overflow: hidden; background: var(--bg-surface); transform: translateZ(0); contain: layout style; }
  .detail-layer { position: absolute; inset: 0; z-index: calc(var(--z-reader) + 10); background: var(--bg-surface); }
</style>
