#!/usr/bin/env node
/**
 * Genera las tarjetas SVG de estadísticas del perfil a partir de la API de GitHub.
 *
 * Se ejecuta en GitHub Actions y commitea los SVG al repo, de modo que el README
 * no depende de ningún servicio externo (las instancias públicas de
 * github-readme-stats se caen con frecuencia por rate limit).
 *
 *   GITHUB_TOKEN=... node scripts/generate-stats.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const OUT = join(ROOT, "assets")

const USER = process.env.STATS_USER || "axchisan"
const TOKEN = process.env.GITHUB_TOKEN
if (!TOKEN) {
  console.error("Falta GITHUB_TOKEN")
  process.exit(1)
}

/**
 * Repos donde se versionaron dependencias de terceros (venv de Python,
 * vendor/ de Composer). Cuentan megabytes de librerías que nadie escribió y
 * distorsionan por completo el reparto de lenguajes.
 */
const EXCLUDE_REPOS = new Set([
  "proyectoChatBotNetflix",
  "Bootcam_IA_Mintic",
  "AxIA",
  "textcortbackend",
  "reservaVehiculos",
  "Consultorio_Emily_Bernal",
  "conEmilyBernal-Vservidor",
  "Branches-test",
])

/** Lenguajes que solo aparecen como subproducto de librerías compiladas. */
const HIDE_LANGS = new Set([
  "Cython", "C", "C++", "CMake", "Meson", "Fortran", "Cuda", "Hack", "Roff",
  "M4", "Assembly", "Perl", "Objective-C", "Smarty", "Lex", "Yacc",
  "Batchfile", "PowerShell", "SWIG", "Rich Text Format", "Emacs Lisp",
])

const TOP_LANGS = 8

// ─────────────────────────────────────────── API

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "axchisan-profile-stats",
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`)
  const json = await res.json()
  if (json.errors) throw new Error(JSON.stringify(json.errors))
  return json.data
}

async function fetchProfile() {
  const data = await gql(
    `query ($login: String!, $cursor: String) {
      user(login: $login) {
        login
        name
        createdAt
        followers { totalCount }
        repositories(
          first: 100
          after: $cursor
          ownerAffiliations: OWNER
          isFork: false
        ) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            name
            stargazerCount
            languages(first: 25, orderBy: { field: SIZE, direction: DESC }) {
              edges { size node { name color } }
            }
          }
        }
      }
    }`,
    { login: USER },
  )

  const user = data.user
  const repos = [...user.repositories.nodes]
  let page = user.repositories.pageInfo
  while (page.hasNextPage) {
    const next = await gql(
      `query ($login: String!, $cursor: String) {
        user(login: $login) {
          repositories(first: 100, after: $cursor, ownerAffiliations: OWNER, isFork: false) {
            pageInfo { hasNextPage endCursor }
            nodes {
              name
              stargazerCount
              languages(first: 25, orderBy: { field: SIZE, direction: DESC }) {
                edges { size node { name color } }
              }
            }
          }
        }
      }`,
      { login: USER, cursor: page.endCursor },
    )
    repos.push(...next.user.repositories.nodes)
    page = next.user.repositories.pageInfo
  }

  return { user, repos }
}

/** El calendario de contribuciones solo admite ventanas de 1 año: se pagina por año. */
async function fetchCalendar(createdAt) {
  const start = new Date(createdAt)
  const today = new Date()
  const days = new Map()
  const totals = { commits: 0, prs: 0, issues: 0, reviews: 0, restricted: 0 }

  for (let year = start.getUTCFullYear(); year <= today.getUTCFullYear(); year++) {
    const from = new Date(Date.UTC(year, 0, 1)) < start ? start : new Date(Date.UTC(year, 0, 1))
    const to = new Date(Date.UTC(year, 11, 31, 23, 59, 59))
    const data = await gql(
      `query ($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $from, to: $to) {
            totalCommitContributions
            totalPullRequestContributions
            totalIssueContributions
            totalPullRequestReviewContributions
            restrictedContributionsCount
            contributionCalendar {
              weeks { contributionDays { date contributionCount } }
            }
          }
        }
      }`,
      { login: USER, from: from.toISOString(), to: (to > today ? today : to).toISOString() },
    )
    const c = data.user.contributionsCollection
    totals.commits += c.totalCommitContributions
    totals.prs += c.totalPullRequestContributions
    totals.issues += c.totalIssueContributions
    totals.reviews += c.totalPullRequestReviewContributions
    totals.restricted += c.restrictedContributionsCount
    for (const week of c.contributionCalendar.weeks)
      for (const day of week.contributionDays) days.set(day.date, day.contributionCount)
  }

  return { days, totals }
}

// ─────────────────────────────────────────── cálculo

function computeStreaks(days) {
  const sorted = [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const total = sorted.reduce((acc, [, n]) => acc + n, 0)

  let longest = 0, longestStart = null, longestEnd = null
  let run = 0, runStart = null
  for (const [date, count] of sorted) {
    if (count > 0) {
      if (run === 0) runStart = date
      run++
      if (run > longest) { longest = run; longestStart = runStart; longestEnd = date }
    } else {
      run = 0
    }
  }

  // Racha actual: se cuenta hacia atrás desde hoy. Un día de hoy todavía sin
  // contribuciones no rompe la racha (aún queda día por delante).
  const byDate = new Map(sorted)
  const cursor = new Date()
  const iso = (d) => d.toISOString().slice(0, 10)
  if (!(byDate.get(iso(cursor)) > 0)) cursor.setUTCDate(cursor.getUTCDate() - 1)

  let current = 0, currentEnd = iso(cursor), currentStart = iso(cursor)
  while ((byDate.get(iso(cursor)) || 0) > 0) {
    current++
    currentStart = iso(cursor)
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }
  if (current === 0) { currentStart = null; currentEnd = null }

  const first = sorted.find(([, n]) => n > 0)?.[0] || sorted[0]?.[0]
  return { total, current, currentStart, currentEnd, longest, longestStart, longestEnd, first }
}

function computeLanguages(repos) {
  const bytes = new Map()
  const colors = new Map()
  for (const repo of repos) {
    if (EXCLUDE_REPOS.has(repo.name)) continue
    for (const edge of repo.languages.edges) {
      const name = edge.node.name
      if (HIDE_LANGS.has(name)) continue
      bytes.set(name, (bytes.get(name) || 0) + edge.size)
      if (edge.node.color) colors.set(name, edge.node.color)
    }
  }
  const total = [...bytes.values()].reduce((a, b) => a + b, 0)
  return [...bytes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_LANGS)
    .map(([name, size]) => ({
      name,
      pct: (size / total) * 100,
      color: colors.get(name) || "#94A3B8",
    }))
}

// ─────────────────────────────────────────── SVG

const THEMES = {
  dark: {
    bg: "#0D1117", border: "#1E293B", title: "#22D3EE", text: "#C9D1D9",
    dim: "#64748B", accent: "#C084FC", track: "#1E293B", glow: "#6366F1",
  },
  light: {
    bg: "#FFFFFF", border: "#E2E8F0", title: "#0891B2", text: "#334155",
    dim: "#94A3B8", accent: "#9333EA", track: "#E2E8F0", glow: "#818CF8",
  },
}

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const nf = new Intl.NumberFormat("es-CO")
const num = (n) => nf.format(n)

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]
function humanDate(iso) {
  if (!iso) return "—"
  const [y, m, d] = iso.split("-").map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}

const SANS = "Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif"
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"

/**
 * Marco común: fondo redondeado y borde.
 *
 * Nada se dibuja con `opacity: 0` a la espera de una animación: la app móvil de
 * GitHub, las previsualizaciones y los lectores que respetan
 * `prefers-reduced-motion` no ejecutan animaciones, y la tarjeta saldría vacía.
 * Las animaciones que sí se usan son SMIL con `fill="freeze"` partiendo del
 * estado final, así que degradan a la tarjeta completa.
 */
function frame(w, h, t, title, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
  <defs>
    <linearGradient id="acc" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${t.glow}"/>
      <stop offset="50%" stop-color="${t.title}"/>
      <stop offset="100%" stop-color="${t.accent}"/>
    </linearGradient>
    <clipPath id="cut"><rect width="${w}" height="${h}" rx="14"/></clipPath>
  </defs>
  <g clip-path="url(#cut)">
    <rect width="${w}" height="${h}" fill="${t.bg}"/>
    <rect width="${w}" height="3" fill="url(#acc)"/>
    ${body}
    <rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="14" fill="none" stroke="${t.border}"/>
  </g>
</svg>
`
}

function cardStats(t, d) {
  const rows = [
    ["Commits totales", num(d.commits)],
    ["Pull requests", num(d.prs)],
    ["Repositorios propios", num(d.repos)],
    ["Estrellas recibidas", num(d.stars)],
    ["Seguidores", num(d.followers)],
    ["Contribuciones totales", num(d.contributions)],
  ]
  const body = `
    <text x="26" y="42" font-family="${SANS}" font-size="17" font-weight="700" fill="${t.title}">Estadísticas de @${esc(USER)}</text>
    <text x="26" y="63" font-family="${MONO}" font-size="11.5" fill="${t.dim}">desde ${humanDate(d.since)}${d.includesPrivate ? " · incluye actividad privada" : ""}</text>
    ${rows
      .map((r, i) => {
        const y = 96 + i * 27
        return `<g>
      <circle cx="30" cy="${y - 4}" r="3" fill="${i % 2 ? t.accent : t.title}"/>
      <text x="44" y="${y}" font-family="${SANS}" font-size="13.5" fill="${t.text}">${esc(r[0])}</text>
      <text x="${470 - 26}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="15" font-weight="700" fill="${t.title}">${esc(r[1])}</text>
    </g>`
      })
      .join("\n")}`
  return frame(470, 268, t, `Estadísticas de GitHub de ${USER}`, body)
}

function cardLangs(t, langs) {
  const W = 470, X = 26, BW = W - X * 2
  let x = X
  const bar = langs
    .map((l, i) => {
      const w = Math.max(2, (l.pct / 100) * BW)
      const seg = `<rect x="${x.toFixed(1)}" y="82" width="${w.toFixed(1)}" height="11" fill="${l.color}"><animate attributeName="width" from="0" to="${w.toFixed(1)}" dur=".8s" begin="${(.15 + i * .07).toFixed(2)}s" fill="freeze"/></rect>`
      x += w
      return seg
    })
    .join("")

  const rows = langs
    .map((l, i) => {
      const col = i % 2
      const row = Math.floor(i / 2)
      const cx = X + col * 218
      const cy = 128 + row * 26
      return `<g>
      <circle cx="${cx + 5}" cy="${cy - 4}" r="5" fill="${l.color}"/>
      <text x="${cx + 18}" y="${cy}" font-family="${SANS}" font-size="13" fill="${t.text}">${esc(l.name)}</text>
      <text x="${cx + 196}" y="${cy}" text-anchor="end" font-family="${MONO}" font-size="12.5" fill="${t.dim}">${l.pct.toFixed(1)}%</text>
    </g>`
    })
    .join("\n")

  const h = 128 + Math.ceil(langs.length / 2) * 26 + 30
  const body = `
    <text x="${X}" y="42" font-family="${SANS}" font-size="17" font-weight="700" fill="${t.title}">Lenguajes más usados</text>
    <text x="${X}" y="63" font-family="${MONO}" font-size="11.5" fill="${t.dim}">sobre código propio · sin dependencias versionadas</text>
    <rect x="${X}" y="82" width="${BW}" height="11" rx="5.5" fill="${t.track}"/>
    <g clip-path="url(#barclip)">${bar}</g>
    <defs><clipPath id="barclip"><rect x="${X}" y="82" width="${BW}" height="11" rx="5.5"/></clipPath></defs>
    ${rows}`
  return frame(W, h, t, "Lenguajes más usados", body)
}

/** Un rango de un solo día se muestra como fecha suelta, no como "X — X". */
function range(from, to) {
  if (!from) return "—"
  return from === to ? humanDate(from) : `${humanDate(from)} — ${humanDate(to)}`
}

function cardStreak(t, s) {
  const W = 470, H = 200, COL = W / 3
  const cols = [
    { label: "Contribuciones", value: num(s.total), sub: `${humanDate(s.first)} — hoy`, color: t.text },
    { label: "Racha actual", value: num(s.current), sub: s.current ? range(s.currentStart, s.currentEnd) : "sin racha activa", color: t.title, ring: true },
    { label: "Racha más larga", value: num(s.longest), sub: range(s.longestStart, s.longestEnd), color: t.text },
  ]
  const body = cols
    .map((c, i) => {
      const cx = COL / 2 + i * COL
      // El anillo rodea solo la cifra: las etiquetas van debajo para no pisarlo.
      const ring = c.ring
        ? `<circle cx="${cx}" cy="82" r="34" fill="none" stroke="${t.title}" stroke-width="2.5" stroke-opacity=".8"/>
      <circle cx="${cx}" cy="82" r="34" fill="none" stroke="${t.accent}" stroke-width="2.5" stroke-dasharray="52 162" stroke-linecap="round" transform="rotate(-90 ${cx} 82)"/>`
        : ""
      const div = i < 2 ? `<line x1="${(i + 1) * COL}" y1="46" x2="${(i + 1) * COL}" y2="164" stroke="${t.border}"/>` : ""
      return `<g>
      ${ring}
      <text x="${cx}" y="93" text-anchor="middle" font-family="${MONO}" font-size="30" font-weight="700" fill="${c.color}">${esc(c.value)}</text>
      <text x="${cx}" y="138" text-anchor="middle" font-family="${SANS}" font-size="12.5" font-weight="600" fill="${c.ring ? t.title : t.text}">${esc(c.label)}</text>
      <text x="${cx}" y="157" text-anchor="middle" font-family="${MONO}" font-size="9.5" fill="${t.dim}">${esc(c.sub)}</text>
    </g>${div}`
    })
    .join("\n")
  return frame(W, H, t, "Racha de contribuciones", body)
}

// ─────────────────────────────────────────── main

const { user, repos } = await fetchProfile()
const { days, totals } = await fetchCalendar(user.createdAt)
const streaks = computeStreaks(days)
const langs = computeLanguages(repos)

const stats = {
  commits: totals.commits + totals.restricted,
  prs: totals.prs,
  repos: repos.length,
  stars: repos.reduce((a, r) => a + r.stargazerCount, 0),
  followers: user.followers.totalCount,
  contributions: streaks.total,
  since: user.createdAt.slice(0, 10),
  // El GITHUB_TOKEN por defecto de Actions solo ve lo público. Con un PAT
  // (secret STATS_TOKEN) aparece también la actividad en repos privados.
  includesPrivate: totals.restricted > 0,
}

mkdirSync(OUT, { recursive: true })
for (const [name, theme] of Object.entries(THEMES)) {
  writeFileSync(join(OUT, `stats-${name}.svg`), cardStats(theme, stats))
  writeFileSync(join(OUT, `langs-${name}.svg`), cardLangs(theme, langs))
  writeFileSync(join(OUT, `streak-${name}.svg`), cardStreak(theme, streaks))
}

console.log("Tarjetas generadas:", {
  ...stats,
  rachaActual: streaks.current,
  rachaMasLarga: streaks.longest,
  lenguajes: langs.map((l) => `${l.name} ${l.pct.toFixed(1)}%`),
})
