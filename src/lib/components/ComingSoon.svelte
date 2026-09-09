<script>
  import Topbar from "$lib/components/Topbar.svelte";
  let { title = "" } = $props();
</script>

<Topbar brand={title} />
<div class="container">
  <div class="card-box">
    <h2 style="margin-top:0;">{title}</h2>
    <p style="color:#666;">This page hasn't been ported to Svelte yet — it's next up in the page-by-page rebuild.</p>
    <a class="btn btn-secondary" href="/">&larr; Back to Home</a>
  </div>
</div>
