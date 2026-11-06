/** Minimal ASCII DXF reader: splits a file into entities, blocks and layer state. */

export type Pair = [code: number, value: string]

export interface Entity {
  type: string
  layer: string
  pairs: Pair[]
  /** VERTEX records, for POLYLINE entities only. */
  vertices: Entity[]
}

export interface Block {
  baseX: number
  baseY: number
  entities: Entity[]
}

export interface Dxf {
  entities: Entity[]
  blocks: Map<string, Block>
  hiddenLayers: Set<string>
  /** An SVG-compatible length unit, or null if the file doesn't give a usable one. */
  unit: 'mm' | 'cm' | 'in' | null
}

/** First value for a group code, as a number. */
export function num(e: Entity, code: number, fallback = 0): number {
  const pair = e.pairs.find((p) => p[0] === code)
  const value = pair ? Number(pair[1]) : NaN
  return Number.isNaN(value) ? fallback : value
}

/** Every value for a repeated group code, as numbers. */
export function nums(e: Entity, code: number): number[] {
  return e.pairs.filter((p) => p[0] === code).map((p) => Number(p[1]))
}

function str(e: Entity, code: number): string {
  return e.pairs.find((p) => p[0] === code)?.[1] ?? ''
}

function readPairs(text: string): Pair[] {
  if (text.startsWith('AutoCAD Binary DXF')) {
    throw new Error('This is a binary DXF. Re-save it as ASCII DXF and try again.')
  }
  const lines = text.split(/\r\n|\r|\n/)
  const pairs: Pair[] = []
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim()
    if (!/^-?\d+$/.test(code)) {
      throw new Error(`Not a valid DXF file (unexpected content on line ${i + 1}).`)
    }
    const value = lines[i + 1].trim()
    pairs.push([Number(code), value])
    if (pairs.at(-1)![0] === 0 && value === 'EOF') break
  }
  return pairs
}

function readSections(pairs: Pair[]): Map<string, Pair[]> {
  const sections = new Map<string, Pair[]>()
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0] !== 0 || pairs[i][1] !== 'SECTION') continue
    const name = pairs[i + 1]?.[1] ?? ''
    const start = i + 2
    while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1] === 'ENDSEC')) i++
    sections.set(name, pairs.slice(start, i))
  }
  return sections
}

/** Splits a section into records, each starting at a group code 0. */
function readRecords(pairs: Pair[]): Entity[] {
  const records: Entity[] = []
  for (const pair of pairs) {
    if (pair[0] === 0) {
      records.push({ type: pair[1], layer: '0', pairs: [], vertices: [] })
    } else if (records.length > 0) {
      const record = records.at(-1)!
      record.pairs.push(pair)
      if (pair[0] === 8) record.layer = pair[1]
    }
  }
  return records
}

/** Attaches VERTEX records to their POLYLINE and drops paper-space entities. */
function collectEntities(records: Entity[]): Entity[] {
  const entities: Entity[] = []
  let polyline: Entity | null = null
  for (const record of records) {
    if (record.type === 'VERTEX' && polyline) {
      polyline.vertices.push(record)
    } else if (record.type === 'SEQEND') {
      polyline = null
    } else {
      if (record.type === 'POLYLINE') polyline = record
      if (num(record, 67) !== 1) entities.push(record)
    }
  }
  return entities
}

function readBlocks(records: Entity[]): Map<string, Block> {
  const blocks = new Map<string, Block>()
  let header: Entity | null = null
  let body: Entity[] = []
  for (const record of records) {
    if (record.type === 'BLOCK') {
      header = record
      body = []
    } else if (record.type === 'ENDBLK') {
      if (header) {
        blocks.set(str(header, 2), {
          baseX: num(header, 10),
          baseY: num(header, 20),
          entities: collectEntities(body),
        })
      }
      header = null
    } else {
      body.push(record)
    }
  }
  return blocks
}

function readHiddenLayers(records: Entity[]): Set<string> {
  const hidden = new Set<string>()
  for (const record of records) {
    if (record.type !== 'LAYER') continue
    const frozen = (num(record, 70) & 1) !== 0
    const off = num(record, 62, 7) < 0
    if (frozen || off) hidden.add(str(record, 2))
  }
  return hidden
}

function headerInt(header: Pair[], name: string): number | null {
  const i = header.findIndex((p) => p[0] === 9 && p[1] === name)
  return i >= 0 && header[i + 1]?.[0] === 70 ? Number(header[i + 1][1]) : null
}

function readUnit(header: Pair[]): Dxf['unit'] {
  const insunits = headerInt(header, '$INSUNITS')
  if (insunits) return ({ 1: 'in', 4: 'mm', 5: 'cm' } as const)[insunits as 1 | 4 | 5] ?? null
  const measurement = headerInt(header, '$MEASUREMENT')
  if (measurement === null) return null
  return measurement === 1 ? 'mm' : 'in'
}

export function parseDxf(text: string): Dxf {
  const sections = readSections(readPairs(text))
  const entities = sections.get('ENTITIES')
  if (!entities) throw new Error('No ENTITIES section found. Is this a DXF file?')
  return {
    entities: collectEntities(readRecords(entities)),
    blocks: readBlocks(readRecords(sections.get('BLOCKS') ?? [])),
    hiddenLayers: readHiddenLayers(readRecords(sections.get('TABLES') ?? [])),
    unit: readUnit(sections.get('HEADER') ?? []),
  }
}
