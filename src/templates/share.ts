import { BUILD_ID } from '../build-info'

// Página pública de solo lectura para un enlace compartido (/share/:token).
// Todo el contenido llega ya resuelto: los archivos de Drive/R2 se sirven a
// través del worker con URLs con token, nunca con acceso directo a la nube.

export interface ShareMediaVM {
  name: string
  kind: 'video' | 'image'
  src: string | null
  poster?: string | null
  caption?: string
  meta?: string
}

export interface ShareDocVM {
  name: string
  viewUrl: string | null
  dlUrl: string | null
  meta?: string
}

export interface ShareSectionVM {
  title: string
  items: { title: string; meta?: string; body?: string }[]
}

export interface ShareViewModel {
  title: string
  caseTitle?: string
  expiresAt?: string
  media: ShareMediaVM[]
  docs: ShareDocVM[]
  sections?: ShareSectionVM[]
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function mediaCard(m: ShareMediaVM): string {
  const viewer = m.src
    ? (m.kind === 'video'
        ? `<video controls preload="metadata" ${m.poster ? `poster="${esc(m.poster)}"` : ''} src="${esc(m.src)}"></video>`
        : `<a href="${esc(m.src)}" target="_blank" rel="noreferrer"><img loading="lazy" src="${esc(m.src)}" alt="${esc(m.name)}" /></a>`)
    : `<div class="noview">Vista no disponible</div>`
  return `<figure class="media">
    ${viewer}
    <figcaption>
      <strong>${esc(m.name)}</strong>${m.kind === 'video' ? ' <span class="pill">video</span>' : ''}
      ${m.caption ? `<div class="cap">${esc(m.caption)}</div>` : ''}
      ${m.meta ? `<div class="meta">${esc(m.meta)}</div>` : ''}
    </figcaption>
  </figure>`
}

function docRow(d: ShareDocVM): string {
  const actions = [
    d.viewUrl ? `<a class="btn" href="${esc(d.viewUrl)}" target="_blank" rel="noreferrer">Ver</a>` : '',
    d.dlUrl ? `<a class="btn" href="${esc(d.dlUrl)}">Descargar</a>` : '',
  ].join('')
  return `<li class="doc">
    <span class="docname">${esc(d.name)}</span>
    ${d.meta ? `<span class="meta">${esc(d.meta)}</span>` : ''}
    <span class="actions">${actions}</span>
  </li>`
}

function section(s: ShareSectionVM): string {
  const items = s.items.map(i => `<div class="item">
    <div class="ititle">${esc(i.title)}</div>
    ${i.meta ? `<div class="meta">${esc(i.meta)}</div>` : ''}
    ${i.body ? `<p class="body">${esc(i.body)}</p>` : ''}
  </div>`).join('')
  return `<section><h2>${esc(s.title)}</h2>${items}</section>`
}

export function getShareHtml(vm: ShareViewModel): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${esc(vm.title)} — Expediente (solo lectura)</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Inter:wght@400;500;600&family=Barlow+Condensed:wght@700&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, system-ui, sans-serif;
      background: #F3F1EC; color: #1C2B2B;
      -webkit-font-smoothing: antialiased;
      padding: 24px 16px 48px;
    }
    .wrap { max-width: 860px; margin: 0 auto; }
    .eyebrow {
      font-family: 'Barlow Condensed', sans-serif; font-weight: 700; font-size: 10px;
      letter-spacing: 0.22em; text-transform: uppercase; color: #D27653; margin-bottom: 10px;
    }
    h1 { font-family: 'Fraunces', Georgia, serif; font-weight: 600; font-size: 26px; letter-spacing: -0.02em; margin-bottom: 6px; }
    .sub { font-size: 13px; color: #4A5656; margin-bottom: 6px; }
    .ro {
      display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600;
      background: #FBEEE5; color: #A85638; border: 1px solid #D27653;
      border-radius: 999px; padding: 3px 10px; margin: 6px 0 22px;
    }
    h2 {
      font-family: 'Fraunces', Georgia, serif; font-weight: 600; font-size: 17px;
      margin: 26px 0 12px; padding-bottom: 6px; border-bottom: 1px solid rgba(28,43,43,0.25);
    }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
    .media { background: #FFFFFF; border: 1px solid rgba(28,43,43,0.12); border-radius: 14px; overflow: hidden; }
    .media video, .media img { display: block; width: 100%; max-height: 340px; object-fit: contain; background: #101a1a; }
    .media img { background: #EDEBE4; }
    .media figcaption { padding: 10px 12px; font-size: 12.5px; }
    .media .cap { color: #4A5656; margin-top: 3px; }
    .pill { font-size: 10px; font-weight: 600; color: #A85638; background: #FBEEE5; border-radius: 999px; padding: 1px 7px; }
    .noview { padding: 30px; text-align: center; color: #8E9494; font-size: 12px; }
    ul.docs { list-style: none; display: flex; flex-direction: column; gap: 8px; }
    .doc {
      background: #FFFFFF; border: 1px solid rgba(28,43,43,0.12); border-radius: 10px;
      padding: 10px 14px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    }
    .docname { font-size: 13px; font-weight: 500; flex: 1; min-width: 160px; overflow-wrap: anywhere; }
    .meta { font-size: 11px; color: #8E9494; }
    .actions { display: inline-flex; gap: 6px; margin-left: auto; }
    .btn {
      font-size: 12px; font-weight: 500; text-decoration: none; color: #2A3A3A;
      border: 1px solid rgba(28,43,43,0.22); border-radius: 6px; padding: 6px 12px; background: #FFF;
    }
    .btn:hover { border-color: #D27653; color: #A85638; }
    section .item { background: #FFFFFF; border: 1px solid rgba(28,43,43,0.12); border-radius: 10px; padding: 10px 14px; margin-bottom: 8px; }
    .ititle { font-size: 13px; font-weight: 600; }
    .body { font-size: 12.5px; color: #2A3A3A; margin-top: 4px; line-height: 1.65; white-space: pre-wrap; }
    footer { margin-top: 40px; padding-top: 14px; border-top: 1px solid rgba(28,43,43,0.15); font-size: 11px; color: #8E9494; line-height: 1.7; }
    code { font-family: ui-monospace, monospace; font-size: 10px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="eyebrow">Expediente</div>
    <h1>${esc(vm.title)}</h1>
    ${vm.caseTitle ? `<div class="sub">${esc(vm.caseTitle)}</div>` : ''}
    <div class="ro">&#128274; Acceso de solo lectura${vm.expiresAt ? ` &middot; expira ${esc(vm.expiresAt)}` : ''}</div>

    ${vm.media.length ? `<h2>Fotos y videos (${vm.media.length})</h2><div class="grid">${vm.media.map(mediaCard).join('')}</div>` : ''}
    ${vm.docs.length ? `<h2>Documentos (${vm.docs.length})</h2><ul class="docs">${vm.docs.map(docRow).join('')}</ul>` : ''}
    ${(vm.sections || []).map(section).join('')}

    <footer>
      Este enlace fue compartido en modo de solo lectura. No reenviar sin autorización del titular.<br />
      Expediente &middot; <code>build ${esc(BUILD_ID)}</code>
    </footer>
  </div>
</body>
</html>`
}
