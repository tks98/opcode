<!--
  StartScreen.svelte - the first thing people see: pick a language and start.

  Shown on a first visit (no projects yet), from the logo, and for "New
  project". Recent projects are listed so returning people can carry on.
-->

<script>
  import { LANGUAGES, PROJECT_LANGUAGES, TOOLCHAINS, projectAppearance } from '../languages.js'
  import { projectStore } from '../stores/projects.svelte.js'
  import { timeAgo } from '../time.js'
  import Icon from './Icon.svelte'
  import ThemeToggle from './ThemeToggle.svelte'
  import Wordmark from './Wordmark.svelte'

  // Opcode is AGPL-licensed: whoever runs a changed copy for others must
  // offer them its source code, so point this at yours.
  const SOURCE_URL = 'https://github.com/tks98/opcode'

  let { onCreate = () => {}, onOpen = () => {}, onImport = () => {}, onBack = null, environmentIssue = null } = $props()

  const RECENT_COUNT = 5

  let selected = $state(PROJECT_LANGUAGES[0])
  let showAll = $state(false)
  let now = $state(Date.now())

  let language = $derived(LANGUAGES[selected])
  let projects = $derived([...projectStore.projects].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)))
  let recent = $derived(showAll ? projects : projects.slice(0, RECENT_COUNT))

  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 60_000)
    return () => clearInterval(timer)
  })

  // The starter file without its "Welcome to Opcode" comment.
  function preview(id) {
    return LANGUAGES[id].starter.content.replace(/^((?:#!.*|<\?php)\n)?(?:#|\/\/|--) Welcome to Opcode.*\n\n?/, '$1')
  }

  function downloadNote(id) {
    const toolchain = TOOLCHAINS[LANGUAGES[id].toolchain]
    if (!toolchain) return 'Nothing extra to download'
    const size = toolchain.sizeMB + (toolchain.requires ?? []).reduce((sum, companion) => sum + TOOLCHAINS[companion].sizeMB, 0)
    return `First run downloads ${size} MB`
  }

  function describe(project) {
    return `${projectAppearance(project).name}, ${timeAgo(project.updatedAt ?? project.createdAt, now)}`
  }

  function scrollToProjects(event) {
    event.preventDefault()
    const section = document.getElementById('projects')
    section?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    section?.querySelector('button')?.focus({ preventScroll: true })
  }
</script>

<div class="start">
  <header class="bar">
    {#if onBack}
      <button class="home" onclick={onBack} aria-label="Back to your project" title="Back to your project">
        <Wordmark size={24} />
      </button>
    {:else}
      <Wordmark size={24} blink />
    {/if}
    <nav aria-label="Main">
      {#if projects.length}
        <a class="btn btn-quiet my-projects" href="#projects" onclick={scrollToProjects}>My projects</a>
      {/if}
      <button class="btn open-file" onclick={onImport} aria-label="Open a file" title="Open a project (.zip) or a Linux machine (.opcode-linux)">
        <Icon name="upload" size={18} />
        <span class="label">Open a file</span>
      </button>
      <ThemeToggle />
    </nav>
  </header>

  {#if environmentIssue}
    <div class="banner" role="alert">{environmentIssue}</div>
  {/if}

  <main>
    <section class="pick" aria-labelledby="start-title">
      <div class="intro">
        <h1 id="start-title">What will you make today?</h1>
        <p>Pick a language and press Run. It all runs in your browser, so there is nothing to install.</p>
      </div>

      <div class="languages" role="group" aria-label="Languages">
        {#each PROJECT_LANGUAGES as id (id)}
          <button
            class="language"
            aria-pressed={selected === id}
            style="--mark: {LANGUAGES[id].color}"
            onclick={() => (selected = id)}
            ondblclick={() => onCreate(id)}
          >
            <span class="strip" aria-hidden="true"></span>
            <span class="name">{LANGUAGES[id].name}</span>
            <span class="hint">{LANGUAGES[id].hint}</span>
          </button>
        {/each}
      </div>

      <div class="machines">
        <button class="linux" onclick={() => onCreate('linux')}>
          <span class="prompt" aria-hidden="true">$_</span>
          <span class="linux-text">
            <span class="linux-title">Learn the Linux terminal</span>
            <span class="hint">A real Linux computer in your browser, with lessons that check your work.</span>
          </span>
          <Icon name="chevronRight" size={20} />
        </button>
        <button class="linux" onclick={() => onCreate('docker')}>
          <span class="prompt docker" aria-hidden="true"><Icon name="container" size={22} /></span>
          <span class="linux-text">
            <span class="linux-title">Learn Docker</span>
            <span class="hint">Build images and run containers with real Docker, on a Linux computer in your browser.</span>
          </span>
          <Icon name="chevronRight" size={20} />
        </button>
      </div>
    </section>

    <aside class="side" aria-label="{language.name} starter program">
      <div class="sample">
        <div class="sample-head">
          <span class="mark" style="--mark: {language.color}"></span>
          <span class="file">{language.starter.path}</span>
          <span class="size">{downloadNote(selected)}</span>
        </div>
        <pre>{preview(selected)}</pre>
      </div>

      <button class="btn btn-primary go" onclick={() => onCreate(selected)}>
        <Icon name="play" size={20} />
        <span>Start coding in {language.name}</span>
      </button>

      {#if projects.length}
        <section id="projects" class="recent" aria-labelledby="recent-title">
          <h2 id="recent-title">Continue where you left off</h2>
          <ul>
            {#each recent as project (project.id)}
              <li>
                <button class="project" onclick={() => onOpen(project.id)} style="--mark: {projectAppearance(project).color}">
                  <span class="project-mark" aria-hidden="true"></span>
                  <span class="project-text">
                    <span class="project-name">{project.name}</span>
                    <span class="project-meta">{describe(project)}</span>
                  </span>
                </button>
              </li>
            {/each}
          </ul>
          {#if projects.length > RECENT_COUNT}
            <button class="btn btn-quiet more" onclick={() => (showAll = !showAll)} aria-expanded={showAll}>
              {showAll ? 'Show fewer' : `Show all ${projects.length} projects`}
            </button>
          {/if}
        </section>
      {/if}
    </aside>
  </main>

  <footer>
    <span>Your projects are saved in this browser. Your code is never uploaded.</span>
    <span>Opcode is free software (AGPL-3.0): <a href={SOURCE_URL} target="_blank" rel="noopener">source code</a> · <a href="third-party-licenses.txt" target="_blank">third-party licenses</a></span>
  </footer>
</div>

<style>
  .start {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow-y: auto;
    background-color: var(--bg);
    background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);
    background-size: 24px 24px;
  }

  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px 16px;
    padding: 14px 40px;
    border-bottom: 2px solid var(--line);
    background: var(--bar);
  }

  .home {
    padding: 6px;
    margin: -6px;
    border: 0;
    border-radius: var(--radius);
    background: transparent;
  }

  nav {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-left: auto;
  }

  .banner {
    padding: 10px 40px;
    background: var(--danger-soft);
    color: var(--danger);
    font-weight: 600;
  }

  main {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 40px;
    width: 100%;
    max-width: 1280px;
    margin: 0 auto;
    padding: 40px 40px 32px;
  }

  .pick {
    display: flex;
    flex: 999 1 560px;
    flex-direction: column;
    gap: 24px;
    min-width: 0;
  }

  h1 {
    margin: 0;
    font-size: clamp(36px, 5vw, 54px);
    font-weight: 760;
    font-variation-settings: var(--casual);
    letter-spacing: -0.02em;
    line-height: 1.05;
  }

  .intro p {
    max-width: 34em;
    margin: 14px 0 0;
    color: var(--muted);
    font-size: 19px;
    line-height: 1.5;
  }

  .languages {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 14px;
  }

  .language {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 118px;
    padding: 0 14px 14px;
    overflow: hidden;
    border: 2px solid var(--line);
    border-radius: 12px;
    background: var(--surface);
    color: var(--ink);
    text-align: left;
    transition: border-color 0.12s, box-shadow 0.12s, transform 0.12s;
  }

  .language:hover {
    border-color: var(--muted);
  }

  .language[aria-pressed='true'] {
    border-color: var(--line-strong);
    box-shadow: 0 4px 0 var(--line-strong);
    transform: translateY(-2px);
  }

  .strip {
    display: block;
    height: 10px;
    margin: 0 -14px 6px;
    background: var(--mark);
  }

  .name {
    font-size: 20px;
    font-weight: 760;
    font-variation-settings: var(--casual);
  }

  .hint {
    color: var(--muted);
    font-size: 14px;
    line-height: 1.4;
  }

  .machines {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 12px;
  }

  .linux {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 16px 18px;
    border: 2px dashed var(--line);
    border-radius: 12px;
    background: color-mix(in srgb, var(--surface) 70%, transparent);
    color: var(--ink);
    text-align: left;
  }

  .linux:hover {
    border-color: var(--muted);
  }

  .prompt {
    flex-shrink: 0;
    padding: 6px 10px;
    border-radius: var(--radius-s);
    background: var(--ink);
    color: var(--bg);
    font-family: var(--font-code);
    font-size: 18px;
    font-variation-settings: var(--mono);
    font-weight: 700;
  }

  .prompt.docker {
    display: grid;
    padding: 7px 10px;
    place-items: center;
    background: #1d63ed;
    color: #fff;
  }

  .linux-text {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .linux-title {
    font-size: 17px;
    font-weight: 700;
  }

  .side {
    display: flex;
    flex: 1 1 380px;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
  }

  .sample {
    overflow: hidden;
    border: 2px solid var(--line);
    border-radius: var(--radius-l);
    background: var(--surface);
    box-shadow: 0 2px 0 var(--line);
  }

  .sample-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 2px solid var(--line);
  }

  .sample-head .mark {
    width: 12px;
    height: 12px;
  }

  .file {
    font-weight: 700;
  }

  .size {
    margin-left: auto;
    color: var(--muted);
    font-size: 13px;
    text-align: right;
  }

  pre {
    max-height: 320px;
    margin: 0;
    padding: 16px 20px;
    overflow: auto;
    color: var(--ink);
    font-size: 14px;
    line-height: 1.6;
    tab-size: 4;
    white-space: pre-wrap;
  }

  .go {
    min-height: 56px;
    border-radius: var(--radius-l);
    box-shadow: 0 4px 0 var(--highlight-ink);
    font-size: 19px;
  }

  .recent {
    display: flex;
    flex-direction: column;
    gap: 8px;
    scroll-margin-top: 16px;
  }

  h2 {
    margin: 4px 0 0;
    font-size: 16px;
    font-weight: 700;
  }

  ul {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .project {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 10px 14px;
    border: 2px solid var(--line);
    border-radius: 12px;
    background: var(--surface);
    color: var(--ink);
    text-align: left;
  }

  .project:hover {
    border-color: var(--muted);
  }

  .project-mark {
    flex-shrink: 0;
    width: 10px;
    height: 34px;
    border-radius: 3px;
    background: var(--mark);
  }

  .project-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .project-name {
    overflow: hidden;
    font-weight: 700;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .project-meta {
    color: var(--muted);
    font-size: 13px;
  }

  .more {
    align-self: flex-start;
    color: var(--link);
  }

  footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 4px 24px;
    padding: 14px 40px;
    border-top: 2px solid var(--line);
    background: var(--bar);
    color: var(--muted);
    font-size: 13px;
  }

  @media (max-width: 1000px) {
    .languages {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 640px) {
    .bar,
    footer,
    .banner {
      padding-right: 16px;
      padding-left: 16px;
    }

    .bar {
      flex-wrap: nowrap;
      padding-top: 10px;
      padding-bottom: 10px;
    }

    .my-projects {
      display: none;
    }

    .open-file {
      width: 40px;
      padding: 0;
    }

    .open-file .label {
      display: none;
    }

    main {
      gap: 28px;
      padding: 24px 16px;
    }

    .intro p {
      font-size: 17px;
    }

    .languages {
      gap: 10px;
    }

    .language {
      min-height: 96px;
    }

    .name {
      font-size: 18px;
    }

    pre {
      max-height: 200px;
      font-size: 13px;
    }

    /* Keep Start in reach while scrolling through the languages. */
    .go {
      position: fixed;
      right: 16px;
      bottom: 16px;
      left: 16px;
      z-index: 10;
    }

    footer {
      padding-bottom: 96px;
    }
  }
</style>
