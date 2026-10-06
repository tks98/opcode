<!--
  Wordmark.svelte - "opcode" in Recursive Mono with a highlighter cursor.
-->

<script>
  let { size = 22, blink = false } = $props()
</script>

<span class="wordmark" style="--size: {size}px">
  <span class="text">opcode</span><span class="cursor" class:blink aria-hidden="true"></span>
</span>

<style>
  .wordmark {
    display: inline-flex;
    align-items: center;
    color: var(--ink);
    font-size: var(--size);
    font-variation-settings: var(--mono);
    font-weight: 800;
    letter-spacing: -0.02em;
    line-height: 1;
  }

  .cursor {
    display: inline-block;
    width: 0.48em;
    height: 1.08em;
    margin-left: 0.12em;
    border-radius: 2px;
    background: var(--highlight);
  }

  .blink {
    animation: blink 1.1s steps(1) 3 1s;
  }

  @keyframes blink {
    50% {
      opacity: 0;
    }
  }
</style>
