import { Hono } from 'hono'

const app = new Hono()
const port = Number(Bun.env.PORT || 4000)

app.use('*', async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('Cache-Control', 'no-store')
})

app.get('/healthz', (c) =>
  c.json({ ok: true, service: 'dovedale-geoguesser-maintenance' }),
)

app.get('*', (c) => c.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#09090b">
  <meta name="robots" content="noindex, nofollow">
  <meta name="description" content="Dovedale GeoGuesser is temporarily undergoing maintenance.">
  <title>Under Maintenance... | Dovedale GeoGuesser</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,1,0&display=block" rel="stylesheet">
  <style>
    :root {
      color-scheme: dark;
      --bg: #09090b;
      --surface: #18181b;
      --surface-hover: #202027;
      --border: #27272a;
      --text: #f4f4f5;
      --muted: #a1a1aa;
      --subtle: #71717a;
      --blue: #93c5fd;
      --blue-strong: #60a5fa;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-synthesis: none;
      text-rendering: optimizeLegibility;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100svh; margin: 0; display: flex; flex-direction: column;
      background: var(--bg); color: var(--text);
    }
    header {
      min-height: 64px; padding: 0 24px; display: flex; align-items: center;
      border-bottom: 1px solid #18181b;
    }
    .brand {
      display: inline-flex; align-items: center; gap: 10px;
      color: var(--text); text-decoration: none; font-size: 14px; font-weight: 650;
      letter-spacing: -.01em;
    }
    .brand-icon {
      width: 32px; height: 32px; display: grid; place-items: center;
      background: #1e293b; color: #bfdbfe; border: 1px solid #263449;
      border-radius: 10px;
    }
    .material-symbols-outlined { font-size: 20px; line-height: 1; }
    main {
      flex: 1; width: min(100% - 36px, 520px); margin: 0 auto;
      display: flex; align-items: center; justify-content: center;
      padding: 72px 0 88px;
    }
    .content { width: 100%; }
    h1 {
      margin: 22px 0 14px; font-size: clamp(32px, 6vw, 44px);
      line-height: 1.13; letter-spacing: -.045em; font-weight: 700;
    }
    .message {
      margin: 0; color: var(--muted); font-size: 15px; line-height: 1.75;
      max-width: 475px;
    }
    .info-card {
      display: flex; gap: 14px; align-items: flex-start; margin-top: 28px;
      padding: 18px; border: 1px solid var(--border); border-radius: 16px;
      background: var(--surface);
    }
    .info-icon {
      flex: 0 0 38px; height: 38px; display: grid; place-items: center;
      color: var(--blue); background: #172337; border-radius: 12px;
    }
    .info-title { margin: 1px 0 5px; font-size: 14px; font-weight: 650; }
    .info-text { color: var(--muted); font-size: 13px; line-height: 1.6; margin: 0; }
    .actions { display: flex; align-items: center; gap: 12px; margin-top: 24px; }
    button, .link {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      min-height: 42px; padding: 0 16px; border-radius: 12px;
      font: inherit; font-size: 13px; font-weight: 600; text-decoration: none;
      transition: background .15s, border-color .15s;
    }
    button {
      color: #0c1420; background: #bfdbfe; border: 1px solid #bfdbfe; cursor: pointer;
    }
    button:hover { background: #dbeafe; border-color: #dbeafe; }
    .link {
      color: #d4d4d8; background: transparent; border: 1px solid var(--border);
    }
    .link:hover { background: var(--surface-hover); border-color: #3f3f46; }
    button:focus-visible, a:focus-visible { outline: 2px solid var(--blue-strong); outline-offset: 3px; }
    footer {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 18px 24px; border-top: 1px solid #18181b; color: var(--subtle);
      font-size: 12px;
    }
    footer a { color: var(--subtle); text-decoration: none; }
    footer a:hover { color: var(--muted); }
    @media (max-width: 480px) {
      header { padding: 0 18px; }
      main { padding: 54px 0 64px; }
      .actions { align-items: stretch; flex-direction: column; }
      button, .link { width: 100%; }
      footer { padding: 16px 18px; }
    }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; } }
  </style>
</head>
<body>
  <header>
    <a class="brand" href="https://dovedalegeoguesser.com/" aria-label="Dovedale GeoGuesser home">
      <span class="brand-icon" aria-hidden="true">
        <span class="material-symbols-outlined">explore</span>
      </span>
      <span>Dovedale GeoGuesser</span>
    </a>
  </header>

  <main>
    <section class="content" aria-labelledby="page-title">
      <h1 id="page-title">Under Maintenance...</h1>
      <p class="message">We’re updating Dovedale GeoGuesser and its systems. The website will be open again soon.</p>

      <div class="info-card" role="status">
        <span class="info-icon" aria-hidden="true">
          <span class="material-symbols-outlined">build</span>
        </span>
        <div>
          <p class="info-title">We’ll be back soon</p>
          <p class="info-text">Your stats and progress aren’t going anywhere. Please check back in a little while.</p>
        </div>
      </div>

      <div class="actions">
        <button type="button" onclick="window.location.reload()">
          <span class="material-symbols-outlined">refresh</span>
          Try again
        </button>
        <a class="link" href="https://dovedalegeoguesser.com/">
          <span class="material-symbols-outlined">home</span>
          Go to Homepage
        </a>
      </div>
    </section>
  </main>

  <footer>
    <span>:D</span>
    <a href="https://github.com/Sectly/dovedale-geoguesser">GitHub</a>
  </footer>
</body>
</html>`))

export default {
  port,
  hostname: '0.0.0.0',
  fetch: app.fetch,
}
