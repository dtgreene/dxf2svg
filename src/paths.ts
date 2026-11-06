/**
 * Geometry pipeline: DXF entities -> paths -> joined chains -> merged segments.
 *
 * A path is a list of vertices, each holding the bulge of the segment leaving
 * it (the DXF polyline convention): 0 is a straight line, otherwise
 * tan(sweep / 4), positive for counter-clockwise. True arcs stay arcs all the
 * way to the SVG.
 */
import KDBush from 'kdbush'
import { compose, identity, rotateDEG, scale, translate, type Matrix } from 'transformation-matrix'
import { num, nums, type Dxf, type Entity } from './dxf.ts'

export interface Vertex {
  x: number
  y: number
  b: number
}

export interface Path {
  layer: string
  closed: boolean
  pts: Vertex[]
}

export interface Flattened {
  paths: Path[]
  /** Number of DXF entities that produced geometry. */
  entities: number
  /** What was left out, and how many of each. */
  skipped: Map<string, number>
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

type Shape = Pick<Path, 'closed' | 'pts'>

const TAU = Math.PI * 2
const EPSILON = 1e-9
const ELLIPSE_STEPS = 128
const SPLINE_STEPS_PER_SPAN = 16
const ARC_STEP = Math.PI / 36
const MAX_BLOCK_DEPTH = 16

const dist = (p: Vertex, q: Vertex) => Math.hypot(q.x - p.x, q.y - p.y)
const vertex = (x: number, y: number, b = 0): Vertex => ({ x, y, b })

export const segmentCount = (path: Path) => (path.closed ? path.pts.length : path.pts.length - 1)

export const totalSegments = (paths: Path[]) =>
  paths.reduce((sum, path) => sum + segmentCount(path), 0)

/** Centre, radius and signed sweep of the arc from p to q (p.b must be non-zero). */
export function arcOf(p: Vertex, q: Vertex) {
  const k = (1 - p.b * p.b) / (4 * p.b)
  const cx = (p.x + q.x) / 2 - (q.y - p.y) * k
  const cy = (p.y + q.y) / 2 + (q.x - p.x) * k
  return {
    cx,
    cy,
    r: Math.hypot(p.x - cx, p.y - cy),
    start: Math.atan2(p.y - cy, p.x - cx),
    sweep: 4 * Math.atan(p.b),
  }
}

function segmentLength(p: Vertex, q: Vertex): number {
  if (p.b === 0) return dist(p, q)
  const arc = arcOf(p, q)
  return arc.r * Math.abs(arc.sweep)
}

function pathLength(path: Path): number {
  let length = 0
  for (let i = 0; i < segmentCount(path); i++) {
    length += segmentLength(path.pts[i], path.pts[(i + 1) % path.pts.length])
  }
  return length
}

export function bounds(paths: Path[]): Bounds {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  const include = (x: number, y: number) => {
    box.minX = Math.min(box.minX, x)
    box.minY = Math.min(box.minY, y)
    box.maxX = Math.max(box.maxX, x)
    box.maxY = Math.max(box.maxY, y)
  }
  for (const path of paths) {
    const n = path.pts.length
    path.pts.forEach((p) => include(p.x, p.y))
    for (let i = 0; i < segmentCount(path); i++) {
      if (path.pts[i].b === 0) continue
      const arc = arcOf(path.pts[i], path.pts[(i + 1) % n])
      const direction = Math.sign(arc.sweep)
      for (let quadrant = 0; quadrant < 4; quadrant++) {
        const angle = (quadrant * Math.PI) / 2
        const offset = (((angle - arc.start) * direction) % TAU + TAU) % TAU
        if (offset <= Math.abs(arc.sweep)) {
          include(arc.cx + arc.r * Math.cos(angle), arc.cy + arc.r * Math.sin(angle))
        }
      }
    }
  }
  return box
}

export function diagonal(paths: Path[]): number {
  const box = bounds(paths)
  return Math.hypot(box.maxX - box.minX, box.maxY - box.minY)
}

// --- Entities to paths -------------------------------------------------------

function circleShape(cx: number, cy: number, r: number): Shape {
  return { closed: true, pts: [vertex(cx + r, cy, 1), vertex(cx - r, cy, 1)] }
}

function arcShape(e: Entity): Shape {
  const cx = num(e, 10)
  const cy = num(e, 20)
  const r = num(e, 40)
  const startDeg = num(e, 50)
  const sweepDeg = (((num(e, 51) - startDeg) % 360) + 360) % 360
  if (sweepDeg < EPSILON) return circleShape(cx, cy, r)
  const start = (startDeg * Math.PI) / 180
  const end = start + (sweepDeg * Math.PI) / 180
  return {
    closed: false,
    pts: [
      vertex(cx + r * Math.cos(start), cy + r * Math.sin(start), Math.tan((end - start) / 4)),
      vertex(cx + r * Math.cos(end), cy + r * Math.sin(end)),
    ],
  }
}

function lwPolylineShape(e: Entity): Shape {
  const pts: Vertex[] = []
  for (const [code, value] of e.pairs) {
    if (code === 10) pts.push(vertex(Number(value), 0))
    else if (pts.length === 0) continue
    else if (code === 20) pts.at(-1)!.y = Number(value)
    else if (code === 42) pts.at(-1)!.b = Number(value)
  }
  return { closed: (num(e, 70) & 1) !== 0, pts }
}

function polylineShape(e: Entity): Shape {
  const pts = e.vertices
    .filter((v) => (num(v, 70) & 16) === 0) // Spline frame control points aren't on the curve.
    .map((v) => vertex(num(v, 10), num(v, 20), num(v, 42)))
  return { closed: (num(e, 70) & 1) !== 0, pts }
}

function ellipseShape(e: Entity): Shape {
  const cx = num(e, 10)
  const cy = num(e, 20)
  const mx = num(e, 11)
  const my = num(e, 21)
  const ratio = num(e, 40, 1) * (num(e, 230, 1) < 0 ? -1 : 1)
  const start = num(e, 41, 0)
  let sweep = num(e, 42, TAU) - start
  if (sweep <= 0) sweep += TAU
  const closed = Math.abs(sweep - TAU) < EPSILON
  const steps = Math.max(8, Math.ceil((sweep / TAU) * ELLIPSE_STEPS))
  const pts: Vertex[] = []
  for (let i = 0; i < (closed ? steps : steps + 1); i++) {
    const t = start + (sweep * i) / steps
    const cos = Math.cos(t)
    const sin = Math.sin(t) * ratio
    pts.push(vertex(cx + mx * cos - my * sin, cy + my * cos + mx * sin))
  }
  return { closed, pts }
}

/** Evaluates a rational B-spline at t within knot span k, using de Boor's algorithm. */
function deBoor(t: number, k: number, degree: number, knots: number[], ctrl: number[][]): Vertex {
  const d = Array.from({ length: degree + 1 }, (_, j) => [...ctrl[k - degree + j]])
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = j + k - degree
      const a = (t - knots[i]) / (knots[i + 1 + degree - r] - knots[i])
      d[j] = d[j].map((value, axis) => (1 - a) * d[j - 1][axis] + a * value)
    }
  }
  const [x, y, w] = d[degree]
  return vertex(x / w, y / w)
}

function splineShape(e: Entity): Shape {
  const closed = (num(e, 70) & 1) !== 0
  const degree = num(e, 71, 3)
  const knots = nums(e, 40)
  const weights = nums(e, 41)
  const xs = nums(e, 10)
  const ys = nums(e, 20)
  if (xs.length <= degree || knots.length !== xs.length + degree + 1) {
    // No usable control net: fall back to the fit points, or the raw control points.
    const fitXs = nums(e, 11)
    const fitYs = nums(e, 21)
    const pts = fitXs.length > 1 ? fitXs.map((x, i) => vertex(x, fitYs[i])) : xs.map((x, i) => vertex(x, ys[i]))
    return { closed, pts }
  }
  const ctrl = xs.map((x, i) => {
    const w = weights[i] ?? 1
    return [x * w, ys[i] * w, w]
  })
  const pts: Vertex[] = []
  let lastSpan = degree
  for (let k = degree; k < xs.length; k++) {
    const span = knots[k + 1] - knots[k]
    if (span <= 0) continue
    lastSpan = k
    for (let s = 0; s < SPLINE_STEPS_PER_SPAN; s++) {
      pts.push(deBoor(knots[k] + (span * s) / SPLINE_STEPS_PER_SPAN, k, degree, knots, ctrl))
    }
  }
  pts.push(deBoor(knots[lastSpan + 1], lastSpan, degree, knots, ctrl))
  return { closed, pts }
}

/** Replaces arcs with short straight lines, for transforms an arc can't survive. */
function tessellateArcs(shape: Shape): Shape {
  const n = shape.pts.length
  const pts: Vertex[] = []
  shape.pts.forEach((p, i) => {
    const hasNext = shape.closed || i < n - 1
    if (p.b === 0 || !hasNext) {
      pts.push(vertex(p.x, p.y))
      return
    }
    const arc = arcOf(p, shape.pts[(i + 1) % n])
    const steps = Math.ceil(Math.abs(arc.sweep) / ARC_STEP)
    for (let s = 0; s < steps; s++) {
      const angle = arc.start + (arc.sweep * s) / steps
      pts.push(vertex(arc.cx + arc.r * Math.cos(angle), arc.cy + arc.r * Math.sin(angle)))
    }
  })
  return { closed: shape.closed, pts }
}

function transform(shape: Shape, m: Matrix): Shape {
  const { a, b, c, d, e, f } = m
  const similar =
    Math.abs(a * a + b * b - c * c - d * d) < EPSILON && Math.abs(a * c + b * d) < EPSILON
  const source = similar ? shape : tessellateArcs(shape)
  const mirrored = a * d - b * c < 0
  return {
    closed: source.closed,
    pts: source.pts.map((p) =>
      vertex(a * p.x + c * p.y + e, b * p.x + d * p.y + f, mirrored ? -p.b : p.b),
    ),
  }
}

const MIRROR_X = scale(-1, 1)

/** Resolves every entity to world-space paths, expanding block inserts. */
export function flatten(dxf: Dxf): Flattened {
  const result: Flattened = { paths: [], entities: 0, skipped: new Map() }
  const skip = (reason: string) => {
    result.skipped.set(reason, (result.skipped.get(reason) ?? 0) + 1)
  }

  const visit = (entities: Entity[], world: Matrix, parentLayer: string | null, depth: number) => {
    for (const e of entities) {
      // Block contents drawn on layer 0 take on the layer of the insert.
      const layer = e.layer === '0' && parentLayer ? parentLayer : e.layer
      if (dxf.hiddenLayers.has(layer) || num(e, 60) === 1) {
        skip('hidden')
        continue
      }
      // Entities with a -Z extrusion are stored mirrored in their object coordinates.
      const ocs = num(e, 230, 1) < 0 ? compose(world, MIRROR_X) : world

      if (e.type === 'INSERT') {
        const block = dxf.blocks.get(e.pairs.find((p) => p[0] === 2)?.[1] ?? '')
        if (!block || depth >= MAX_BLOCK_DEPTH) {
          skip('INSERT')
          continue
        }
        const place = compose(ocs, translate(num(e, 10), num(e, 20)), rotateDEG(num(e, 50)))
        const fit = compose(
          scale(num(e, 41, 1), num(e, 42, 1)),
          translate(-block.baseX, -block.baseY),
        )
        for (let row = 0; row < Math.max(1, num(e, 71, 1)); row++) {
          for (let col = 0; col < Math.max(1, num(e, 70, 1)); col++) {
            const cell = translate(col * num(e, 44), row * num(e, 45))
            visit(block.entities, compose(place, cell, fit), layer, depth + 1)
          }
        }
        continue
      }

      let shape: Shape
      switch (e.type) {
        case 'LINE':
          shape = transform(
            { closed: false, pts: [vertex(num(e, 10), num(e, 20)), vertex(num(e, 11), num(e, 21))] },
            world,
          )
          break
        case 'CIRCLE':
          shape = transform(circleShape(num(e, 10), num(e, 20), num(e, 40)), ocs)
          break
        case 'ARC':
          shape = transform(arcShape(e), ocs)
          break
        case 'LWPOLYLINE':
          shape = transform(lwPolylineShape(e), ocs)
          break
        case 'POLYLINE': {
          const flags = num(e, 70)
          if ((flags & (16 | 64)) !== 0) {
            skip('POLYLINE mesh')
            continue
          }
          shape = transform(polylineShape(e), (flags & 8) !== 0 ? world : ocs)
          break
        }
        case 'ELLIPSE':
          shape = transform(ellipseShape(e), world)
          break
        case 'SPLINE':
          shape = transform(splineShape(e), world)
          break
        default:
          skip(e.type)
          continue
      }
      if (shape.pts.length < 2) continue
      result.paths.push({ layer, ...shape })
      result.entities++
    }
  }

  visit(dxf.entities, identity(), null, 0)
  return result
}

// --- Joining -----------------------------------------------------------------

function reversed(pts: Vertex[]): Vertex[] {
  const last = pts.length - 1
  return pts.map((_, k) => {
    const p = pts[last - k]
    return vertex(p.x, p.y, last - k > 0 ? -pts[last - k - 1].b : 0)
  })
}

/** Removes zero-length segments. */
function withoutDuplicates(path: Path): Path {
  const pts: Vertex[] = []
  for (const p of path.pts) {
    const top = pts.at(-1)
    if (top && dist(top, p) <= EPSILON) top.b = p.b
    else pts.push({ ...p })
  }
  if (path.closed && pts.length > 1 && dist(pts[0], pts.at(-1)!) <= EPSILON) pts.pop()
  return { ...path, pts }
}

function joinLayer(paths: Path[], tolerance: number): Path[] {
  const endOf = (id: number) => (id & 1 ? paths[id >> 1].pts.at(-1)! : paths[id >> 1].pts[0])

  const ends = new KDBush(paths.length * 2)
  for (let id = 0; id < paths.length * 2; id++) {
    const p = endOf(id)
    ends.add(p.x, p.y)
  }
  ends.finish()

  const used = new Uint8Array(paths.length)
  const nearestEnd = (p: Vertex): number => {
    let best = -1
    let bestDistance = tolerance
    for (const id of ends.within(p.x, p.y, tolerance)) {
      if (used[id >> 1]) continue
      const distance = dist(p, endOf(id))
      // Ties go to the highest id, so results don't depend on the index's internal order.
      if (distance < bestDistance || (distance === bestDistance && id > best)) {
        best = id
        bestDistance = distance
      }
    }
    return best
  }

  const extend = (chain: Vertex[]) => {
    for (;;) {
      const id = nearestEnd(chain.at(-1)!)
      if (id < 0) return
      used[id >> 1] = 1
      const source = paths[id >> 1].pts
      const next = id & 1 ? reversed(source) : source
      chain.at(-1)!.b = next[0].b
      for (let i = 1; i < next.length; i++) chain.push({ ...next[i] })
    }
  }

  const joined: Path[] = []
  paths.forEach((path, i) => {
    if (used[i]) return
    used[i] = 1
    let chain = path.pts.map((p) => ({ ...p }))
    extend(chain)
    chain = reversed(chain)
    extend(chain)
    chain = reversed(chain)

    const closes = chain.length > 2 && dist(chain[0], chain.at(-1)!) <= tolerance
    if (closes) chain.pop()
    const degenerate = chain.length < 3 && chain.every((p) => p.b === 0)
    joined.push({ layer: path.layer, closed: closes && !degenerate, pts: chain })
  })
  return joined
}

/** Chains paths on the same layer whose endpoints meet within the tolerance. */
export function join(paths: Path[], tolerance: number): Path[] {
  const joined: Path[] = []
  const openByLayer = new Map<string, Path[]>()
  for (const raw of paths) {
    const path = withoutDuplicates(raw)
    if (path.pts.length < 2) continue
    if (path.closed) {
      joined.push(path)
    } else {
      const group = openByLayer.get(path.layer)
      if (group) group.push(path)
      else openByLayer.set(path.layer, [path])
    }
  }
  for (const group of openByLayer.values()) joined.push(...joinLayer(group, tolerance))
  return joined
}

// --- Merging -----------------------------------------------------------------

/** Distance from pts[i] to the straight line that would replace it. */
function deviation(pts: Vertex[], i: number): number {
  const n = pts.length
  const p = pts[(i - 1 + n) % n]
  const q = pts[(i + 1) % n]
  const v = pts[i]
  const dx = q.x - p.x
  const dy = q.y - p.y
  const lengthSquared = dx * dx + dy * dy
  const raw = lengthSquared ? ((v.x - p.x) * dx + (v.y - p.y) * dy) / lengthSquared : 0
  const t = Math.min(1, Math.max(0, raw))
  return Math.hypot(v.x - (p.x + t * dx), v.y - (p.y + t * dy))
}

/** A vertex can go only if it joins two straight lines; arc ends and open ends stay. */
function removable(pts: Vertex[], i: number, closed: boolean): boolean {
  const n = pts.length
  if (!closed && (i === 0 || i === n - 1)) return false
  return pts[i].b === 0 && pts[(i - 1 + n) % n].b === 0
}

/**
 * Repeatedly removes the vertices `pick` nominates (-1 for none). Neighbours of a
 * removed vertex wait for the next pass, so each decision sees up-to-date lengths.
 */
function removeVertices(
  start: Vertex[],
  closed: boolean,
  pick: (pts: Vertex[], i: number) => number,
): Vertex[] {
  const minimum = closed ? 3 : 2
  let pts = start
  for (;;) {
    const n = pts.length
    const touched = new Uint8Array(n)
    const drop = new Uint8Array(n)
    let remaining = n
    for (let i = 0; i < n && remaining > minimum; i++) {
      const k = pick(pts, i)
      if (k < 0) continue
      const before = (k - 1 + n) % n
      const after = (k + 1) % n
      if (touched[k] || touched[before] || touched[after]) continue
      touched[k] = touched[before] = touched[after] = 1
      drop[k] = 1
      remaining--
    }
    if (remaining === n) return pts
    pts = pts.filter((_, i) => !drop[i])
  }
}

function mergePath(path: Path, minLength: number, flatTolerance: number): Path {
  const { closed } = path
  let pts = removeVertices(path.pts, closed, (p, i) =>
    removable(p, i, closed) && deviation(p, i) <= flatTolerance ? i : -1,
  )

  // Anything entirely below the threshold, such as a small hole, is a feature
  // rather than noise, so it is kept as drawn.
  if (minLength <= 0 || pathLength({ ...path, pts }) < minLength * (closed ? 4 : 1)) {
    return { ...path, pts }
  }

  const n = pts.length
  pts = pts.map((p, i) => {
    const hasNext = closed || i < n - 1
    const short = p.b !== 0 && hasNext && segmentLength(p, pts[(i + 1) % n]) < minLength
    return short ? vertex(p.x, p.y) : p
  })

  pts = removeVertices(pts, closed, (p, i) => {
    const count = p.length
    if (!closed && i === count - 1) return -1
    const j = (i + 1) % count
    if (p[i].b !== 0 || dist(p[i], p[j]) >= minLength) return -1
    const canI = removable(p, i, closed)
    const canJ = removable(p, j, closed)
    if (canI && canJ) return deviation(p, i) <= deviation(p, j) ? i : j
    return canI ? i : canJ ? j : -1
  })
  return { ...path, pts }
}

/**
 * Removes collinear vertices, then merges segments shorter than `minLength` into
 * their neighbours. Every remaining vertex is an original one, so curves stay on
 * the drawn line, and arcs at or above the threshold are untouched.
 */
export function merge(paths: Path[], minLength: number): Path[] {
  const flatTolerance = diagonal(paths) * 1e-7
  return paths.map((path) => mergePath(path, minLength, flatTolerance))
}
