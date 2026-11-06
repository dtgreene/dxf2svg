import type { Dxf } from './dxf.ts'
import { arcOf, bounds, segmentCount, type Path } from './paths.ts'

const escapeXml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function pathData(
  path: Path,
  px: (x: number) => string,
  py: (y: number) => string,
  length: (n: number) => string,
): string {
  const { pts, closed } = path
  const n = pts.length
  let d = `M${px(pts[0].x)} ${py(pts[0].y)}`
  for (let i = 0; i < segmentCount(path); i++) {
    const p = pts[i]
    const q = pts[(i + 1) % n]
    if (p.b !== 0) {
      const r = length(arcOf(p, q).r)
      const largeArc = Math.abs(p.b) > 1 ? 1 : 0
      // DXF is Y-up and SVG is Y-down, so counter-clockwise becomes sweep flag 0.
      const sweep = p.b > 0 ? 0 : 1
      d += `A${r} ${r} 0 ${largeArc} ${sweep} ${px(q.x)} ${py(q.y)}`
    } else if (!closed || i < n - 1) {
      d += `L${px(q.x)} ${py(q.y)}`
    }
  }
  return closed ? `${d}Z` : d
}

/** Renders paths at 1:1 scale, with one group per DXF layer. */
export function toSvg(paths: Path[], unit: Dxf['unit']): string {
  const box = bounds(paths)
  const drawnWidth = box.maxX - box.minX
  const drawnHeight = box.maxY - box.minY
  const size = Math.hypot(drawnWidth, drawnHeight) || 1
  const stroke = size / 1000
  const width = drawnWidth + stroke * 2
  const height = drawnHeight + stroke * 2

  const decimals = Math.max(2, Math.ceil(6 - Math.log10(size)))
  const length = (n: number) => String(Number(n.toFixed(decimals)))
  const px = (x: number) => length(x - box.minX + stroke)
  const py = (y: number) => length(box.maxY - y + stroke)

  const layers = new Map<string, Path[]>()
  for (const path of paths) {
    const group = layers.get(path.layer)
    if (group) group.push(path)
    else layers.set(path.layer, [path])
  }

  const ids = new Set<string>()
  const groups = [...layers].map(([name, group]) => {
    const base = `layer-${name.replace(/[^\w-]/g, '_')}`
    let id = base
    for (let i = 2; ids.has(id); i++) id = `${base}-${i}`
    ids.add(id)
    const body = group
      .map((path) => `    <path d="${pathData(path, px, py, length)}"/>`)
      .join('\n')
    return `  <g id="${escapeXml(id)}" data-layer="${escapeXml(name)}">\n${body}\n  </g>`
  })

  const suffix = unit ?? ''
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${length(width)}${suffix}" height="${length(height)}${suffix}" viewBox="0 0 ${length(width)} ${length(height)}" fill="none" stroke="#000" stroke-width="${length(stroke)}" stroke-linecap="round" stroke-linejoin="round">`,
    ...groups,
    '</svg>',
    '',
  ].join('\n')
}
